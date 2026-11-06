import * as maplibregl from '../vendor/maplibre/maplibre-gl.mjs';
import { Network, addDays, romeParts } from './schedule.js';
import { currentDelay, lookup, parseTripUpdates, stopDelays } from './rt.js';
import { Planner } from './planner.js';

const FEEDS = {
  tt: 'https://proxy.busone.app/trentino/gtfs-rt/trip-updates.json',
  trn: 'https://proxy.busone.app/trenitalia/gtfs-rt/trip-updates.json',
};
const BUSONE_HEADERS = { 'X-BusOne-Client': 'tnaa-transit (https://github.com/alexroat/tnaa-transit)', 'X-BusOne-Use': 'personal' };
const POLL_MS = 5 * 60000; // i dati non sono in tempo reale: 5 minuti bastano e pesano poco sulla fonte
const MIN_REFRESH_MS = 30000; // limite per aggiornamento manuale e apertura di una fermata
const MAX_LIVE_AGE_MS = 15 * 60000; // oltre, un ritardo vale meno dell'orario
const SOON_DAYS = 14;
const LIVE_CACHE = 'tnaa-live';
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const FALLBACK_STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e9eee9' } }] };
const HOME = { center: [11.17, 46.08], zoom: 8.9, pitch: 50, bearing: -8 };
const COLORS = { ok: '#2e9d62', warn: '#e6a100', late: '#d32f2f', early: '#2f7fd1', none: '#8a948f' };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const params = new URLSearchParams(location.search);
const now = () => Date.now();

let net;
const rt = { tt: new Map(), trn: new Map(), extra: new Map() };
const feedState = { tt: { ok: false, count: 0, at: 0 }, trn: { ok: false, count: 0, at: 0 } };
let active = [];
let view = { kind: 'home' };
let vehicles = [];
let is3D = true;
let dataDate = '';
let netVersion = '';
let validity = [];
let updateReady = false;
let lastPoll = 0;
let planner;
const plan = { from: null, to: null, when: '', results: null, open: -1 };

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
const liveAge = (feed) => (feedState[feed]?.at ? now() - feedState[feed].at : Infinity);
const fmtDay = (ymd) => `${ymd.slice(6, 8)}/${ymd.slice(4, 6)}/${ymd.slice(0, 4)}`;
const label = (t) => {
  const r = routeOf(t);
  return r.rail && t.short ? `${r.short} ${t.short}` : r.short;
};

function instance(c) {
  const feed = routeOf(c.trip).feed;
  const found = liveAge(feed) <= MAX_LIVE_AGE_MS ? lookup(rt[feed], c.trip.id, c.day) : undefined;
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
  const age = Math.min(liveAge('tt'), liveAge('trn'));
  const parts = [`${fmtTime(sec)}`, `${vehicles.length} in viaggio (${rail} treni)`, `${live} con dati live`];
  if (age <= MAX_LIVE_AGE_MS) parts.push(age < 60000 ? 'ritardi appena aggiornati' : `ritardi di ${Math.floor(age / 60000)} min fa`);
  $('#status').textContent = parts.join(' · ');
  renderBanner();
}

function validityNotes() {
  const today = romeParts(now()).ymd;
  const soon = addDays(today, SOON_DAYS);
  const byDate = new Map();
  for (const v of validity) if (v.until <= soon) byDate.set(v.until, [...(byDate.get(v.until) || []), v.group]);
  return [...byDate].map(([until, groups]) => `${groups.join(', ')}: orari noti solo fino al ${fmtDay(until)}`);
}

function renderBanner() {
  const notes = validityNotes().map(esc);
  const down = ['tt', 'trn'].filter((k) => !feedState[k].ok);
  const usable = Math.min(liveAge('tt'), liveAge('trn')) <= MAX_LIVE_AGE_MS;
  if (down.length === 2) notes.unshift(usable ? 'Senza rete: ritardi salvati' : `Senza rete: orari programmati del ${dataDate}`);
  else if (down.length) notes.unshift(`Dati live ${down[0] === 'trn' ? 'dei treni' : 'dei bus'} non disponibili`);
  if (updateReady) notes.push('Orari aggiornati scaricati. <button id="btn-reload">Usa i nuovi orari</button>');
  const b = $('#banner');
  b.hidden = !notes.length;
  b.innerHTML = notes.join(' · ');
}

async function saveLive(key, text) {
  if (!('caches' in self)) return;
  const c = await caches.open(LIVE_CACHE);
  await c.put(`/live/${key}`, new Response(text, { headers: { 'x-saved-at': String(now()) } }));
}

async function loadSavedLive() {
  if (!('caches' in self)) return;
  const c = await caches.open(LIVE_CACHE);
  await Promise.all(Object.keys(FEEDS).map(async (k) => {
    const res = await c.match(`/live/${k}`);
    if (!res) return;
    const at = +res.headers.get('x-saved-at');
    if (now() - at > MAX_LIVE_AGE_MS) return;
    rt[k] = parseTripUpdates(await res.json());
    feedState[k] = { ok: false, count: rt[k].size, at };
  }));
}

async function poll() {
  lastPoll = now();
  await Promise.all(Object.entries(FEEDS).map(async ([k, url]) => {
    try {
      const res = await fetch(url, { headers: BUSONE_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      rt[k] = parseTripUpdates(JSON.parse(text));
      feedState[k] = { ok: true, count: rt[k].size, at: now() };
      saveLive(k, text).catch((e) => console.warn('salvataggio', k, e));
    } catch (e) {
      console.warn('feed', k, e);
      feedState[k] = { ...feedState[k], ok: false };
    }
  }));
  pushVehicles();
  renderView();
}

/** Controlla il file piccolo; scarica gli orari solo se la versione e cambiata. */
async function checkVersion() {
  try {
    const res = await fetch('data/version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const v = await res.json();
    validity = v.validity || validity;
    if (v.version === netVersion || updateReady) return;
    const fresh = await fetch('data/net.json', { cache: 'reload' });
    if (fresh.ok) updateReady = true;
    renderBanner();
  } catch (e) {
    console.warn('versione', e);
  }
}

function refreshIfStale(minAge = MIN_REFRESH_MS) {
  if (now() - lastPoll >= minAge && !document.hidden) poll();
}

// ---------- Pannello ----------
function tag(r) {
  return `<span class="tag ${r.rail ? 'rail' : ''}">${esc(r.short || '–')}</span>`;
}

function renderView() {
  if (view.kind === 'plan') return; // la vista contiene campi in uso: si ridisegna solo su richiesta
  if (view.kind === 'stop') renderStop(view.stop);
  else if (view.kind === 'trip') renderTrip();
  else if (view.kind === 'search') renderSearch();
  else if (view.kind === 'route') renderRoute();
  else renderHome();
}

function renderHome() {
  const sorted = vehicles.filter((v) => v.delay !== undefined).sort((a, b) => b.delay - a.delay).slice(0, 25);
  const rows = sorted.map((v) => tripRow(v, fmtTime(net.times(v.trip, v.nextPos).arr + (v.delay ?? 0)), v.delay)).join('');
  $('#content').innerHTML = `<button class="primary" data-plan>Pianifica un viaggio</button><h2>Ritardi maggiori</h2>${rows || '<p class="empty">Nessun ritardo disponibile al momento. Di notte il servizio è fermo.</p>'}`;
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
    <p class="sub">Prossime partenze, entro 2 ore</p>
    <p class="actions"><button data-plan-from="${i}">Parti da qui</button><button data-plan-to="${i}">Arriva qui</button></p>${rows || '<p class="empty">Nessuna partenza nelle prossime 2 ore.</p>'}`;
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
    <p class="sub">${esc(r.rail && trip.short ? `Treno ${trip.short} · ` : '')}<span class="d ${severity(x.delay)}">${esc(state)}</span></p>
    ${r.feed === 'extra' ? '<p class="sub">Corsa aggiunta dall\'orario pubblicato da Trentino Trasporti: nessun dato live.</p>' : ''}${rows}`;
}

function makeCandidate(trip, day) {
  const { ymd, sec } = romeParts(now());
  const midnight = now() / 1000 - sec - (day === ymd ? 0 : 86400);
  return { trip, day, midnight };
}

function stopMatches(text, limit) {
  const q = text.toLowerCase();
  const rank = (s) => (s.name.toLowerCase() === q ? 0 : s.name.toLowerCase().startsWith(q) ? 1 : 2);
  return net.stops.filter((s) => s.name.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || b.rail - a.rail || a.name.localeCompare(b.name)).slice(0, limit);
}

function renderSearch() {
  const q = view.q.toLowerCase();
  const stops = stopMatches(q, 25);
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

// ---------- Pianificatore ----------
function localNow() {
  const { ymd, sec } = romeParts(now());
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${fmtTime(sec)}`;
}

function renderPlan() {
  plan.when ||= localNow();
  $('#content').innerHTML = `<button class="back" data-home>← Indietro</button><h2>Pianifica un viaggio</h2>
    <label class="field">Da<input id="p-from" autocomplete="off" placeholder="Fermata o stazione" value="${esc(plan.from === null ? '' : net.stops[plan.from].name)}"></label>
    <div id="p-from-s"></div>
    <label class="field">A<input id="p-to" autocomplete="off" placeholder="Fermata o stazione" value="${esc(plan.to === null ? '' : net.stops[plan.to].name)}"></label>
    <div id="p-to-s"></div>
    <label class="field">Partenza<input id="p-when" type="datetime-local" value="${plan.when}"></label>
    <button class="primary" id="p-go">Cerca</button><div id="p-out"></div>`;
  renderPlanResults();
}

function planLeg(l, day) {
  if (l.walk) return `<p class="leg walk">A piedi fino a ${esc(net.stops[l.to].name)}</p>`;
  const t = net.trips[l.trip];
  const r = routeOf(t);
  const x = day === romeParts(now()).ymd ? instance(makeCandidate(t, day)) : null;
  const live = x?.rec?.canceled ? '<span class="d late">soppressa</span>' : x && x.delay !== undefined ? `<span class="d ${severity(x.delay)}">${delayText(x.delay)}</span>` : '';
  return `<div class="leg">${tag(r)} <b>${esc(t.headsign || r.long)}</b>${r.rail && t.short ? ` <small>${esc(t.short)}</small>` : ''} ${live}
    <small>${fmtTime(l.dep)} ${esc(net.stops[l.from].name)} → ${fmtTime(l.arr)} ${esc(net.stops[l.to].name)}</small></div>`;
}

function renderPlanResults() {
  const out = $('#p-out');
  if (!out || !plan.results) return;
  const day = plan.day;
  const late = validity.filter((v) => v.until < day).map((v) => v.group);
  const warn = late.length ? `<p class="sub">Per questa data mancano gli orari di: ${esc(late.join(', '))}.</p>` : '';
  const rows = plan.results.map((j, i) => {
    const min = Math.round((j.arr - j.dep) / 60);
    const dur = min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
    return `<button class="row journey" data-journey="${i}"><span class="time">${fmtTime(j.dep)}<br>${fmtTime(j.arr)}</span>
      <span class="main"><b>${dur}</b><small>${j.transfers ? `${j.transfers} ${j.transfers === 1 ? 'cambio' : 'cambi'}` : 'Diretto'}</small></span><span></span></button>
      ${plan.open === i ? `<div class="legs">${j.legs.map((l) => planLeg(l, day)).join('')}</div>` : ''}`;
  }).join('');
  out.innerHTML = `${warn}${rows || '<p class="empty">Nessun viaggio trovato entro la giornata.</p>'}
    <p class="sub">Calcolato sugli orari programmati, anche senza rete. Cambio minimo 2 minuti, fino a 300 metri a piedi.</p>`;
}

function runPlan() {
  plan.when = $('#p-when').value || localNow();
  plan.open = -1;
  if (plan.from === null || plan.to === null) {
    $('#p-out').innerHTML = '<p class="empty">Scegli partenza e arrivo dall\'elenco.</p>';
    return;
  }
  planner ||= new Planner(net);
  const [date, time] = plan.when.split('T');
  const [h, m] = time.split(':').map(Number);
  plan.day = date.replaceAll('-', '');
  plan.results = planner.plan(plan.from, plan.to, plan.day, h * 3600 + m * 60);
  renderPlanResults();
}

function showJourney(i) {
  plan.open = plan.open === i ? -1 : i;
  const j = plan.results[i];
  const features = plan.open < 0 ? [] : j.legs.filter((l) => !l.walk).map((l) => {
    const t = net.trips[l.trip];
    const pat = net.patterns[t.pattern];
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: net.shapes[pat.shape].coords }, properties: {} };
  });
  map.getSource('selected').setData({ type: 'FeatureCollection', features });
  renderPlanResults();
}

function show(next) {
  view = next;
  if (next.kind === 'plan') renderPlan();
  else renderView();
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
  refreshIfStale();
  map.getSource('selected').setData({ type: 'FeatureCollection', features: [] });
  map.easeTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 13.5), duration: 700 });
  show({ kind: 'stop', stop: i });
}

$('#content').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'p-go') runPlan();
  else if (b.dataset.journey) showJourney(+b.dataset.journey);
  else if (b.dataset.pick) {
    plan[b.dataset.pick] = +b.dataset.stop;
    plan.results = null;
    show({ kind: 'plan' });
  } else if ('plan' in b.dataset) show({ kind: 'plan' });
  else if (b.dataset.planFrom) {
    plan.from = +b.dataset.planFrom;
    show({ kind: 'plan' });
  } else if (b.dataset.planTo) {
    plan.to = +b.dataset.planTo;
    show({ kind: 'plan' });
  } else if (b.dataset.trip) selectTrip(+b.dataset.trip, b.dataset.day);
  else if (b.dataset.stop) selectStop(+b.dataset.stop);
  else if (b.dataset.route) show({ kind: 'route', route: +b.dataset.route });
  else if ('home' in b.dataset) {
    map.getSource('selected').setData({ type: 'FeatureCollection', features: [] });
    show({ kind: 'home' });
  }
});
$('#content').addEventListener('input', (e) => {
  const key = { 'p-from': 'from', 'p-to': 'to' }[e.target.id];
  if (key) {
    plan[key] = null;
    const q = e.target.value.trim();
    const list = q.length < 2 ? [] : stopMatches(q, 6);
    $(`#${e.target.id}-s`).innerHTML = list.map((s) => `<button class="row pick" data-pick="${key}" data-stop="${s.i}"><span>${s.rail ? '🚉' : '🚏'}</span><span class="main"><b>${esc(s.name)}</b></span><span></span></button>`).join('');
  }
});
$('#banner').addEventListener('click', (e) => {
  if (e.target.id === 'btn-reload') location.reload();
});
$('#btn-refresh').addEventListener('click', async () => {
  const b = $('#btn-refresh');
  b.disabled = true;
  await Promise.all([poll(), checkVersion()]);
  setTimeout(() => { b.disabled = false; }, MIN_REFRESH_MS);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && net) refreshIfStale(POLL_MS);
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
  customAttribution: 'Dati: <a href="https://busone.app">BusOne</a> e fonte originale (Trentino Trasporti, CC BY 4.0; Trenitalia) · DEM: Mapzen/AWS',
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
  netVersion = raw.version;
  validity = raw.validity || [];
  window.__net = net;
  addLayers();
  refreshActive();
  await loadSavedLive().catch((e) => console.warn('ritardi salvati', e));
  pushVehicles();
  renderView();
  await poll();
  checkVersion();
  setInterval(pushVehicles, 1000);
  setInterval(refreshActive, 20000);
  setInterval(() => refreshIfStale(POLL_MS), 30000);
  setInterval(() => { if (view.kind !== 'search') renderView(); }, 15000);
}

if ('serviceWorker' in navigator && !params.has('nosw')) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('sw', e));

start().catch((e) => {
  console.error(e);
  $('#status').textContent = `Errore: ${e.message}`;
});
