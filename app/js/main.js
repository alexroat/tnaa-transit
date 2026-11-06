import * as maplibregl from '../vendor/maplibre/maplibre-gl.mjs';
import { Network, addDays, romeParts } from './schedule.js';
import { currentDelay, lookup, parseTripUpdates, stopDelays } from './rt.js';

const FEEDS = {
  tt: 'https://proxy.busone.app/trentino/gtfs-rt/trip-updates.json',
  trn: 'https://proxy.busone.app/trenitalia/gtfs-rt/trip-updates.json',
};
const BUSONE_HEADERS = { 'X-BusOne-Client': 'tnttmonitor-poc', 'X-BusOne-Use': 'personal' };
const POLL_MS = 30000;
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const FALLBACK_STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e9eee9' } }] };
const HOME = { center: [11.17, 46.08], zoom: 8.9, pitch: 50, bearing: -8 };
const COLORS = { ok: '#2e9d62', warn: '#e6a100', late: '#d32f2f', early: '#2f7fd1', none: '#8a948f' };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const params = new URLSearchParams(location.search);
const now = () => Date.now();

let net;
const rt = { tt: new Map(), trn: new Map() };
const feedState = { tt: { ok: false, count: 0 }, trn: { ok: false, count: 0 } };
let active = [];
let view = { kind: 'home' };
let vehicles = [];
let is3D = true;
let dataDate = '';

const fmtTime = (s) => {
  const v = ((Math.round(s / 60) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};
const severity = (d) => (d === undefined ? 'none' : d < -60 ? 'early' : d < 120 ? 'ok' : d <= 300 ? 'warn' : 'late');
const delayText = (d) => {
  if (d === undefined) return 'solo orario';
  const m = Math.round(d / 60);
  return m === 0 ? 'in orario' : m > 0 ? `+${m} min` : `${m} min`;
};
const routeOf = (t) => net.routes[t.route];
const label = (t) => {
  const r = routeOf(t);
  return r.rail && t.short ? `${r.short} ${t.short}` : r.short;
};

function instance(c) {
  const feed = routeOf(c.trip).feed;
  const found = lookup(rt[feed], c.trip.id, c.day);
  const rec = found && { ...found, midnight: c.midnight };
  const seqs = net.patterns[c.trip.pattern].seqs;
  const at = (i) => net.times(c.trip, i);
  const nowSec = now() / 1000 - c.midnight;
  const delays = stopDelays(rec, seqs, at, nowSec);
  return { ...c, rec, delays, delay: currentDelay(rec, delays, at, nowSec) };
}

function refreshActive() {
  active = net.candidates(now());
}

function vehiclesNow() {
  const list = [];
  const showBus = $('#f-bus').checked;
  const showRail = $('#f-rail').checked;
  const onlyRt = $('#f-rt').checked;
  for (const c of active) {
    const r = routeOf(c.trip);
    if (r.rail ? !showRail : !showBus) continue;
    const x = instance(c);
    if (x.rec?.canceled || (onlyRt && x.delay === undefined)) continue;
    const p = net.locate(c.trip, now() / 1000 - c.midnight, x.delay ?? 0);
    if (p) list.push({ ...x, ...p });
  }
  return list;
}

function pushVehicles() {
  vehicles = vehiclesNow();
  const src = map.getSource('vehicles');
  if (!src) return;
  src.setData({
    type: 'FeatureCollection',
    features: vehicles.map((v) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
      properties: {
        trip: v.trip.i, day: v.day, label: routeOf(v.trip).short, rail: routeOf(v.trip).rail ? 1 : 0,
        color: COLORS[severity(v.delay)], live: v.delay === undefined ? 0 : 1,
      },
    })),
  });
  renderStatus();
}

function renderStatus() {
  const live = vehicles.filter((v) => v.delay !== undefined).length;
  const rail = vehicles.filter((v) => routeOf(v.trip).rail).length;
  const { sec } = romeParts(now());
  const parts = [`${fmtTime(sec)}`, `${vehicles.length} in viaggio (${rail} treni)`, `${live} con dati live`];
  $('#status').textContent = parts.join(' · ');
  renderBanner();
}

function renderBanner() {
  const notes = [];
  if (!feedState.tt.ok && !feedState.trn.ok) notes.push(`Offline: solo orari programmati, aggiornati al ${dataDate}`);
  else if ((!feedState.tt.ok || !feedState.trn.ok)) notes.push(`Dati live ${feedState.tt.ok ? 'dei treni' : 'dei bus'} non disponibili`);
  const b = $('#banner');
  b.hidden = !notes.length;
  b.textContent = notes.join(' · ');
}

async function poll() {
  await Promise.all(Object.entries(FEEDS).map(async ([k, url]) => {
    try {
      const res = await fetch(url, { headers: BUSONE_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      rt[k] = parseTripUpdates(await res.json());
      feedState[k] = { ok: true, count: rt[k].size };
    } catch (e) {
      console.warn('feed', k, e);
      feedState[k] = { ok: false, count: 0 };
    }
  }));
  pushVehicles();
  renderView();
}

// ---------- Pannello ----------
function tag(r) {
  return `<span class="tag ${r.rail ? 'rail' : ''}">${esc(r.short || '–')}</span>`;
}

function renderView() {
  if (view.kind === 'stop') renderStop(view.stop);
  else if (view.kind === 'trip') renderTrip();
  else if (view.kind === 'search') renderSearch();
  else if (view.kind === 'route') renderRoute();
  else renderHome();
}

function renderHome() {
  const sorted = vehicles.filter((v) => v.delay !== undefined).sort((a, b) => b.delay - a.delay).slice(0, 25);
  const rows = sorted.map((v) => tripRow(v, fmtTime(net.times(v.trip, v.nextPos).arr + (v.delay ?? 0)), v.delay)).join('');
  $('#content').innerHTML = `<h2>Ritardi maggiori</h2>${rows || '<p class="empty">Nessun ritardo disponibile al momento. Di notte il servizio è fermo.</p>'}`;
}

function tripRow(v, time, delay, extra = '') {
  const r = routeOf(v.trip);
  return `<button class="row ${extra}" data-trip="${v.trip.i}" data-day="${v.day}">${tag(r)}
    <span class="main"><b>${esc(v.trip.headsign || r.long)}</b><small>${esc(r.rail && v.trip.short ? `Treno ${v.trip.short}` : r.long)}</small></span>
    <span class="time">${time}<br><span class="d ${severity(delay)}">${delayText(delay)}</span></span></button>`;
}

function departures(stopIdx) {
  const nowMs = now();
  const { ymd, sec } = romeParts(nowMs);
  const out = [];
  const entries = net.byStop.get(stopIdx) || [];
  for (const [day, s] of [[ymd, sec], [addDays(ymd, -1), sec + 86400]]) {
    const on = new Set(net.tripsOnDay(day).map((t) => t.i));
    for (const [ti, pos] of entries) {
      if (!on.has(ti)) continue;
      const trip = net.trips[ti];
      const pat = net.patterns[trip.pattern];
      if (pos === pat.stops.length - 1) continue;
      const dep = net.times(trip, pos).dep;
      if (dep < s - 3600 || dep > s + 7200) continue;
      const x = instance({ trip, day, midnight: nowMs / 1000 - s });
      const d = x.delays[pos]?.dep ?? x.delay;
      const eta = dep + (d ?? 0);
      if (eta < s - 120) continue;
      out.push({ ...x, pos, sched: dep, d, eta });
    }
  }
  return out.sort((a, b) => a.eta - b.eta).slice(0, 30);
}

function renderStop(i) {
  const s = net.stops[i];
  const list = departures(i);
  const rows = list.map((v) => {
    const gone = v.rec?.canceled || v.delays[v.pos]?.skipped;
    const time = v.d ? `${fmtTime(v.eta)}<s>${fmtTime(v.sched)}</s>` : fmtTime(v.sched);
    return tripRow(v, gone ? 'Soppressa' : time, v.d, gone ? 'gone' : '');
  }).join('');
  $('#content').innerHTML = `<button class="back" data-home>← Indietro</button><h2>${esc(s.name)}</h2>
    <p class="sub">Prossime partenze, entro 2 ore</p>${rows || '<p class="empty">Nessuna partenza nelle prossime 2 ore.</p>'}`;
}

function renderTrip() {
  const { trip, day } = view;
  const c = active.find((x) => x.trip === trip && x.day === day) || makeCandidate(trip, day);
  const x = instance(c);
  const pat = net.patterns[trip.pattern];
  const r = routeOf(trip);
  const nowSec = now() / 1000 - c.midnight;
  const p = net.locate(trip, nowSec, x.delay ?? 0);
  const rows = pat.stops.map((si, i) => {
    const d = x.delays[i];
    const delay = d?.dep ?? x.delay;
    const sched = net.times(trip, i).dep;
    const eta = sched + (delay ?? 0);
    const cls = eta < nowSec ? 'past' : p?.nextPos === i ? 'next' : '';
    return `<button class="row ${cls}" data-stop="${si}" style="grid-template-columns:44px 1fr auto">
      <span class="time">${fmtTime(sched)}</span>
      <span class="main"><b>${esc(net.stops[si].name)}</b></span>
      <span class="d ${severity(d ? d.dep : undefined)}">${d ? (d.skipped ? 'saltata' : delayText(d.dep)) : ''}</span></button>`;
  }).join('');
  const state = x.rec?.canceled ? 'Corsa soppressa' : delayText(x.delay);
  $('#content').innerHTML = `<button class="back" data-home>← Indietro</button>
    <h2>${tag(r)} ${esc(trip.headsign || r.long)}</h2>
    <p class="sub">${esc(r.rail && trip.short ? `Treno ${trip.short} · ` : '')}<span class="d ${severity(x.delay)}">${esc(state)}</span></p>${rows}`;
}

function makeCandidate(trip, day) {
  const { ymd, sec } = romeParts(now());
  const midnight = now() / 1000 - sec - (day === ymd ? 0 : 86400);
  return { trip, day, midnight };
}

function renderSearch() {
  const q = view.q.toLowerCase();
  const rank = (s) => (s.name.toLowerCase() === q ? 0 : s.name.toLowerCase().startsWith(q) ? 1 : 2);
  const stops = net.stops.filter((s) => s.name.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || b.rail - a.rail || a.name.localeCompare(b.name)).slice(0, 25);
  const seen = new Set();
  const routes = net.routes.filter((r) => {
    const key = `${r.short}|${r.long}`;
    if (seen.has(key) || !`${r.short} ${r.long}`.toLowerCase().includes(q)) return false;
    seen.add(key);
    return true;
  }).slice(0, 15);
  const rr = routes.map((r) => `<button class="row" data-route="${r.i}">${tag(r)}<span class="main"><b>${esc(r.long)}</b></span><span></span></button>`).join('');
  const sr = stops.map((s) => `<button class="row" data-stop="${s.i}"><span>${s.rail ? '🚉' : '🚏'}</span><span class="main"><b>${esc(s.name)}</b></span><span></span></button>`).join('');
  $('#content').innerHTML = (rr + sr) || '<p class="empty">Nessun risultato.</p>';
}

function renderRoute() {
  const r = net.routes[view.route];
  const same = vehicles.filter((v) => routeOf(v.trip).short === r.short && routeOf(v.trip).long === r.long);
  $('#content').innerHTML = `<button class="back" data-home>← Indietro</button><h2>${tag(r)} ${esc(r.long)}</h2>
    <p class="sub">${same.length} mezzi in viaggio ora</p>
    ${same.map((v) => tripRow(v, fmtTime(net.times(v.trip, v.nextPos).arr + (v.delay ?? 0)), v.delay)).join('') || '<p class="empty">Nessun mezzo in viaggio su questa linea.</p>'}`;
}

function show(next) {
  view = next;
  renderView();
  $('#content').scrollTop = 0;
}

function selectTrip(i, day) {
  const trip = net.trips[i];
  const pat = net.patterns[trip.pattern];
  map.getSource('selected').setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: net.shapes[pat.shape].coords }, properties: {} }],
  });
  show({ kind: 'trip', trip, day });
}

function selectStop(i) {
  const s = net.stops[i];
  map.getSource('selected').setData({ type: 'FeatureCollection', features: [] });
  map.easeTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 13.5), duration: 700 });
  show({ kind: 'stop', stop: i });
}

$('#content').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.trip) selectTrip(+b.dataset.trip, b.dataset.day);
  else if (b.dataset.stop) selectStop(+b.dataset.stop);
  else if (b.dataset.route) show({ kind: 'route', route: +b.dataset.route });
  else if ('home' in b.dataset) {
    map.getSource('selected').setData({ type: 'FeatureCollection', features: [] });
    show({ kind: 'home' });
  }
});
$('#search').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  show(q.length < 2 ? { kind: 'home' } : { kind: 'search', q });
});
for (const id of ['#f-bus', '#f-rail', '#f-rt']) $(id).addEventListener('change', pushVehicles);
$('#btn-3d').addEventListener('click', () => {
  is3D = !is3D;
  map.setTerrain(is3D ? { source: 'dem', exaggeration: 1.4 } : null);
  map.easeTo({ pitch: is3D ? HOME.pitch : 0, duration: 800 });
  $('#btn-3d').textContent = is3D ? '2D' : '3D';
});

// ---------- Mappa ----------
// Lo stile si scarica a mano: senza rete e senza cache la mappa parte vuota ma orari e mezzi restano utilizzabili.
const style = await fetch(STYLE_URL).then((r) => (r.ok ? r.json() : FALLBACK_STYLE)).catch(() => FALLBACK_STYLE);
const hasGlyphs = !!style.glyphs;
const map = new maplibregl.Map({ container: 'map', style, maxPitch: 75, ...HOME, attributionControl: false });
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: 'Dati: <a href="https://busone.app">BusOne</a> · Trentino Trasporti · Trenitalia · DEM: Mapzen/AWS',
}));
// Su schermi piccoli i crediti partono chiusi: restano apribili dal pulsante "i".
map.once('load', () => {
  if (innerWidth <= 720) document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
});
window.__map = map;

function networkGeo() {
  const rail = new Set();
  const bus = new Set();
  for (const t of net.trips) (routeOf(t).rail ? rail : bus).add(net.patterns[t.pattern].shape);
  const lines = (set) => [...set].map((s) => ({
    type: 'Feature', geometry: { type: 'LineString', coordinates: net.shapes[s].coords }, properties: {},
  }));
  return { rail: { type: 'FeatureCollection', features: lines(rail) }, bus: { type: 'FeatureCollection', features: lines(bus) } };
}

function addLayers() {
  map.addSource('dem', {
    type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 13,
    tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  });
  map.addLayer({
    id: 'hillshade', type: 'hillshade', source: 'dem',
    paint: { 'hillshade-exaggeration': 0.4, 'hillshade-shadow-color': '#3d4a44' },
  }, firstSymbol());
  map.setTerrain({ source: 'dem', exaggeration: 1.4 });
  map.setSky?.({ 'sky-color': '#bcd9ee', 'horizon-color': '#eaf2f4', 'fog-color': '#eaf2f4', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6 });

  const geo = networkGeo();
  map.addSource('bus-lines', { type: 'geojson', data: geo.bus });
  map.addSource('rail-lines', { type: 'geojson', data: geo.rail });
  map.addSource('selected', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('vehicles', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('stops', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: net.stops.map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { i: s.i, name: s.name, rail: s.rail ? 1 : 0 } })),
    },
  });
  map.addLayer({ id: 'bus-lines', type: 'line', source: 'bus-lines', minzoom: 9, paint: { 'line-color': '#1f5f3f', 'line-opacity': 0.22, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 14, 2] } });
  map.addLayer({ id: 'rail-casing', type: 'line', source: 'rail-lines', paint: { 'line-color': '#fff', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2.5, 14, 6] } });
  map.addLayer({ id: 'rail-lines', type: 'line', source: 'rail-lines', paint: { 'line-color': '#38424a', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.2, 14, 3], 'line-dasharray': [3, 2] } });
  map.addLayer({ id: 'selected', type: 'line', source: 'selected', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0a7cff', 'line-width': 5, 'line-opacity': 0.8 } });
  map.addLayer({
    id: 'stops', type: 'circle', source: 'stops', minzoom: 12.5, filter: ['==', ['get', 'rail'], 0],
    paint: { 'circle-radius': 3.5, 'circle-color': '#fff', 'circle-stroke-color': '#1f5f3f', 'circle-stroke-width': 1.5 },
  });
  map.addLayer({
    id: 'stations', type: 'circle', source: 'stops', filter: ['==', ['get', 'rail'], 1],
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2.5, 13, 6], 'circle-color': '#fff', 'circle-stroke-color': '#38424a', 'circle-stroke-width': 2 },
  });
  if (hasGlyphs) map.addLayer({
    id: 'station-names', type: 'symbol', source: 'stops', minzoom: 10.5, filter: ['==', ['get', 'rail'], 1],
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1], 'text-anchor': 'top', 'text-optional': true },
    paint: { 'text-color': '#38424a', 'text-halo-color': '#fff', 'text-halo-width': 1.4 },
  });
  map.addLayer({
    id: 'vehicles', type: 'circle', source: 'vehicles',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, ['case', ['==', ['get', 'rail'], 1], 5, 3.5], 13, ['case', ['==', ['get', 'rail'], 1], 12, 10]],
      'circle-color': ['case', ['==', ['get', 'live'], 1], ['get', 'color'], '#ffffff'],
      'circle-stroke-color': ['case', ['==', ['get', 'live'], 1], '#ffffff', '#8a948f'],
      'circle-stroke-width': 2,
    },
  });
  if (hasGlyphs) map.addLayer({
    id: 'vehicle-labels', type: 'symbol', source: 'vehicles', minzoom: 11.5,
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-allow-overlap': true },
    paint: { 'text-color': ['case', ['==', ['get', 'live'], 1], '#ffffff', '#3a4440'] },
  });

  const pointer = (id) => {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  };
  ['vehicles', 'stops', 'stations'].forEach(pointer);
  map.on('click', (e) => {
    const hit = map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ['vehicles', 'stations', 'stops'] });
    const f = hit.find((x) => x.layer.id === 'vehicles') || hit[0];
    if (!f) return;
    if (f.layer.id === 'vehicles') selectTrip(f.properties.trip, String(f.properties.day));
    else selectStop(f.properties.i);
  });
}

function firstSymbol() {
  return map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
}

// ---------- Avvio ----------
async function start() {
  const [raw] = await Promise.all([
    fetch('data/net.json').then((r) => r.json()),
    new Promise((ok) => (map.loaded() ? ok() : map.once('load', ok))),
  ]);
  net = new Network(raw);
  dataDate = new Date(raw.generatedAt).toLocaleDateString('it-IT');
  window.__net = net;
  addLayers();
  refreshActive();
  await poll();
  setInterval(pushVehicles, 1000);
  setInterval(refreshActive, 20000);
  setInterval(poll, POLL_MS);
  setInterval(() => { if (view.kind !== 'search') renderView(); }, 15000);
}

if ('serviceWorker' in navigator && !params.has('nosw')) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('sw', e));

start().catch((e) => {
  console.error(e);
  $('#status').textContent = `Errore: ${e.message}`;
});
