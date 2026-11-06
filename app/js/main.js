import * as maplibregl from '../vendor/maplibre/maplibre-gl.mjs';
import { Network, addDays, lineKey, romeParts } from './schedule.js';
import { currentDelay, lookup, parseTripUpdates, stopDelays } from './rt.js';
import { Planner } from './planner.js';
import { iconSvg, mapIcon } from './icons.js';

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
let focus = null; // cio che e selezionato: tutto il resto della rete si nasconde
let sheet = null;
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
        hide: focus && !focus.trips.has(v.trip.i) ? 1 : 0,
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
  if (sheet?.kind === 'trip') renderTripSheet();
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
  return `<span class="tag ${r.rail ? 'rail' : ''}">${iconSvg(r.rail ? 'train' : 'bus')}${esc(r.short || '–')}</span>`;
}

function renderView() {
  if (view.kind === 'plan') return; // la vista contiene campi in uso: si ridisegna solo su richiesta
  if (view.kind === 'stop') renderStop(view.stop);
  else if (view.kind === 'search') renderSearch();
  else if (view.kind === 'lines') renderLines();
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

function stopLine(trip, i, x, nowSec) {
  const d = x.delays[i];
  const delay = d?.dep ?? x.delay;
  const sched = net.times(trip, i).dep;
  const si = net.patterns[trip.pattern].stops[i];
  const shown = d?.skipped ? '' : fmtTime(sched + (delay ?? 0));
  return `<button class="row" data-stop="${si}" style="grid-template-columns:44px 1fr auto">
    <span class="time">${shown}${delay && !d?.skipped && Math.round(delay / 60) ? `<s>${fmtTime(sched)}</s>` : ''}</span>
    <span class="main"><b>${esc(net.stops[si].name)}</b></span>
    <span class="d ${severity(delay)}">${d?.skipped ? 'saltata' : delay === undefined ? '' : delayText(delay)}</span></button>`;
}

function renderTripSheet() {
  const { trip, day } = sheet;
  const el = $('#sheet');
  const wasOpen = el.querySelector('details')?.open;
  const scroll = el.scrollTop;
  const c = active.find((x) => x.trip === trip && x.day === day) || makeCandidate(trip, day);
  const x = instance(c);
  const r = routeOf(trip);
  const nowSec = now() / 1000 - c.midnight;
  const count = net.patterns[trip.pattern].stops.length;
  const p = net.locate(trip, nowSec, x.delay ?? 0);
  const ended = !p && nowSec > net.endTime(trip) + (x.delay ?? 0);
  const next = ended ? count : p ? p.nextPos : 0;
  const state = x.rec?.canceled ? 'Corsa soppressa' : x.delay === undefined ? 'Solo orario, nessun dato live' : `Ritardo: ${delayText(x.delay)}`;
  const moment = ended ? 'Corsa terminata' : p ? 'In viaggio, posizione stimata' : 'Non ancora partita';
  const idx = Array.from({ length: count }, (_, i) => i);
  const ahead = idx.filter((i) => i >= next).map((i) => stopLine(trip, i, x, nowSec)).join('');
  const past = idx.filter((i) => i < next).map((i) => stopLine(trip, i, x, nowSec)).join('');
  const spread = idx.some((i) => i >= next && x.delay !== undefined && x.delays[i] && Math.abs((x.delays[i].dep ?? 0) - x.delay) > 300);
  el.hidden = false;
  el.innerHTML = `${sheetTop()}
    <h2><button class="linklike" data-line="${r.i}" data-pattern="${trip.pattern}" data-day="${day}" title="Apri la scheda della linea">${tag(r)}</button> ${esc(trip.headsign || r.long)}</h2>
    <p class="sub">${esc(r.rail && trip.short ? `Treno ${trip.short} · ` : '')}${moment}</p>
    <p class="delay-line"><span class="d ${severity(x.delay)}">${esc(state)}</span></p>
    ${r.feed === 'extra' ? '<p class="sub">Corsa aggiunta dall\'orario pubblicato da Trentino Trasporti.</p>' : ''}
    ${spread ? '<p class="sub">Per questa corsa la fonte dà previsioni discordanti fra ritardo attuale e prossime fermate: considerale indicative.</p>' : ''}
    <h3>${next < count ? 'Prossime fermate' : 'Fermate'}</h3>${ahead || past}
    ${ahead && past ? `<details ${wasOpen ? 'open' : ''}><summary>Fermate già passate (${next})</summary>${past}</details>` : ''}`;
  el.scrollTop = scroll;
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

function renderLines() {
  const seen = new Set();
  const rows = view.routes.map((i) => net.routes[i]).filter((r) => {
    const k = lineKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map((r) => `<button class="row" data-line="${r.i}">${tag(r)}<span class="main"><b>${esc(r.long || r.short)}</b></span><span></span></button>`).join('');
  $('#content').innerHTML = `<button class="back" data-home>← Indietro</button><h2>Linee in questo punto</h2>${rows}`;
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
  const rr = routes.map((r) => `<button class="row" data-line="${r.i}">${tag(r)}<span class="main"><b>${esc(r.long)}</b></span><span></span></button>`).join('');
  const sr = stops.map((s) => `<button class="row" data-stop="${s.i}"><span class="stop-icon">${iconSvg(s.rail ? 'train' : 'bus')}</span><span class="main"><b>${esc(s.name)}</b></span><span></span></button>`).join('');
  $('#content').innerHTML = (rr + sr) || '<p class="empty">Nessun risultato.</p>';
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
  return `<button class="leg" data-line="${r.i}" data-pattern="${t.pattern}" data-day="${day}" title="Apri la scheda della linea">${tag(r)} <b>${esc(t.headsign || r.long)}</b>${r.rail && t.short ? ` <small style="display:inline">${esc(t.short)}</small>` : ''} ${live}
    <small>${fmtTime(l.dep)} ${esc(net.stops[l.from].name)} → ${fmtTime(l.arr)} ${esc(net.stops[l.to].name)}</small></button>`;
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
  setFocus(plan.open < 0 ? null : journeyFocus(plan.results[i]));
  renderPlanResults();
}

// ---------- Selezione sulla mappa ----------
function rideFeature(trip, from, to) {
  const r = routeOf(trip);
  return {
    type: 'Feature', geometry: { type: 'LineString', coordinates: net.path(trip.pattern, from, to) },
    properties: { line: r.i, pattern: trip.pattern, rail: r.rail ? 1 : 0, walk: 0 },
  };
}

function stopPoints(pattern, from, to) {
  return net.patterns[pattern].stops.slice(from, to + 1).map((si, k, all) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [net.stops[si].lon, net.stops[si].lat] },
    properties: { i: si, name: net.stops[si].name, end: k === 0 || k === all.length - 1 ? 1 : 0 },
  }));
}

function tripFocus(trip) {
  const last = net.patterns[trip.pattern].stops.length - 1;
  return { lines: [rideFeature(trip, 0, last)], points: stopPoints(trip.pattern, 0, last), trips: new Set([trip.i]) };
}

function journeyFocus(j) {
  const f = { lines: [], points: [], trips: new Set() };
  for (const l of j.legs) {
    if (l.walk) {
      const a = net.stops[l.from];
      const b = net.stops[l.to];
      f.lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] }, properties: { walk: 1 } });
    } else {
      const t = net.trips[l.trip];
      f.lines.push(rideFeature(t, l.fromPos, l.toPos));
      f.points.push(...stopPoints(t.pattern, l.fromPos, l.toPos));
      f.trips.add(t.i);
    }
  }
  return f;
}

function fitFocus() {
  const pts = focus.lines.flatMap((f) => f.geometry.coordinates);
  const box = pts.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [180, 90, -180, -90]);
  const wide = innerWidth > 720;
  map.fitBounds([[box[0], box[1]], [box[2], box[3]]], {
    padding: { top: 50, right: 60, left: wide ? (sheet ? 750 : 400) : 30, bottom: wide ? 50 : 40 }, maxZoom: 14, duration: 700,
  });
}

function setFocus(next) {
  focus = next;
  map.getSource('selected').setData({ type: 'FeatureCollection', features: next ? next.lines : [] });
  map.getSource('selected-stops').setData({ type: 'FeatureCollection', features: next ? next.points : [] });
  map.setPaintProperty('bus-lines', 'line-opacity', next ? 0 : 0.22);
  map.setPaintProperty('rail-lines', 'line-opacity', next ? 0.18 : 1);
  map.setPaintProperty('rail-casing', 'line-opacity', next ? 0 : 1);
  for (const id of ['stops', 'stations', 'station-names']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', next ? 'none' : 'visible');
  }
  pushVehicles();
  if (next) fitFocus();
}

// ---------- Scheda linea ----------
function openLine(routeIdx, { pattern, shape, day } = {}) {
  const route = net.routes[routeIdx];
  const when = day || romeParts(now()).ymd;
  const dirs = net.lineVariants(route, when);
  let dir = 0;
  let variant = dirs[0].variants[0];
  dirs.forEach((d, i) => d.variants.forEach((v) => {
    if (v.pattern === pattern || net.patterns[v.pattern].shape === shape) { dir = i; variant = v; }
  }));
  setBar(true);
  sheet = { kind: 'line', route, day: when, dirs, dir, variant, before: sheet ? sheet.before : focus };
  showVariant();
}

function showVariant() {
  const trip = sheet.variant.today[0] || sheet.variant.trips[0];
  renderSheet();
  setFocus(tripFocus(trip));
  focus.trips = new Set(sheet.variant.trips.map((t) => t.i));
  pushVehicles();
}

function sheetTop() {
  return '<button class="sheet-handle" data-toggle-bar aria-label="Riduci o apri la scheda"></button><button class="close" data-close-sheet aria-label="Chiudi la scheda">×</button>';
}

function closeSheet() {
  if (!sheet) return;
  const { before, parent } = sheet;
  if (parent) {
    sheet = parent;
    showVariant();
    return;
  }
  sheet = null;
  $('#sheet').hidden = true;
  setFocus(before);
}

function renderSheet() {
  const { route: r, day, dirs, dir, variant: v } = sheet;
  const total = dirs.reduce((n, d) => n + d.variants.reduce((m, x) => m + x.today.length, 0), 0);
  const key = lineKey(r);
  const running = vehicles.filter((x) => lineKey(routeOf(x.trip)) === key).length;
  const isToday = day === romeParts(now()).ymd;
  const dayText = isToday ? 'oggi' : `il ${fmtDay(day)}`;
  const tabs = dirs.length > 1
    ? `<div class="tabs">${dirs.map((d, i) => `<button class="${i === dir ? 'on' : ''}" data-dir="${i}" title="${esc(d.label)}">${esc(d.label)}</button>`).join('')}</div>`
    : `<h3>${esc(dirs[0].label)}</h3>`;
  const variants = dirs[dir].variants.map((x, i) => {
    const a = net.stops[x.stops[0]].name;
    const b = net.stops[x.stops[x.stops.length - 1]].name;
    return `<button class="variant ${x === v ? 'on' : ''} ${x.today.length ? '' : 'off'}" data-variant="${i}"><b>${esc(a)} → ${esc(b)}</b>
      <small>${esc(x.note)} · ${x.stops.length} fermate · ${x.today.length} ${x.today.length === 1 ? 'corsa' : 'corse'} ${dayText}</small></button>`;
  }).join('');
  const chips = v.today.map((t) => `<button data-trip="${t.i}" data-day="${day}">${fmtTime(t.start)}</button>`).join('');
  const stops = v.stops.map((si) => `<button data-stop="${si}">${esc(net.stops[si].name)}</button>`).join('');
  const el = $('#sheet');
  el.hidden = false;
  el.innerHTML = `${sheetTop()}
    <h2>${tag(r)} ${esc(r.long || r.short)}</h2>
    <p class="sub">${total} ${total === 1 ? 'corsa' : 'corse'} ${dayText}${isToday ? ` · ${running} in viaggio ora` : ''}</p>
    ${tabs}<h3>Varianti</h3>${variants}
    <h3>Partenze ${dayText} di questa variante</h3>
    ${chips ? `<div class="chips">${chips}</div>` : `<p class="sub">Nessuna corsa ${dayText}.</p>`}
    <h3>Fermate</h3><div class="stoplist">${stops}</div>`;
  el.scrollTop = 0;
}

function show(next) {
  view = next;
  if (next.kind === 'plan') renderPlan();
  else renderView();
  $('#content').scrollTop = 0;
}

function selectTrip(i, day) {
  const trip = net.trips[i];
  sheet = { kind: 'trip', trip, day, before: sheet ? sheet.before : focus, parent: sheet?.kind === 'line' ? sheet : null };
  setBar(true);
  renderTripSheet();
  setFocus(tripFocus(trip));
}

/** Su telefono la barra si riduce per lasciare spazio alla mappa. */
function setBar(open) {
  document.body.classList.toggle('bar-closed', !open);
  setTimeout(() => map.resize(), 220);
}

function dropSelection() {
  sheet = null;
  $('#sheet').hidden = true;
  setFocus(null);
}

function selectStop(i) {
  const s = net.stops[i];
  refreshIfStale();
  dropSelection();
  map.easeTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 13.5), duration: 700 });
  show({ kind: 'stop', stop: i });
}

function onPanelClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if ('closeSheet' in b.dataset) closeSheet();
  else if ('toggleBar' in b.dataset) setBar(document.body.classList.contains('bar-closed'));
  else if (b.dataset.dir) {
    sheet.dir = +b.dataset.dir;
    [sheet.variant] = sheet.dirs[sheet.dir].variants;
    showVariant();
  } else if (b.dataset.variant) {
    sheet.variant = sheet.dirs[sheet.dir].variants[+b.dataset.variant];
    showVariant();
  } else if (b.dataset.line) {
    openLine(+b.dataset.line, {
      pattern: b.dataset.pattern === undefined ? undefined : +b.dataset.pattern, day: b.dataset.day,
    });
  }
  else if (b.id === 'p-go') runPlan();
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
  else if ('home' in b.dataset) {
    dropSelection();
    show({ kind: 'home' });
  }
}
$('#btn-bar').addEventListener('click', () => setBar(document.body.classList.contains('bar-closed')));
$('#content').addEventListener('click', onPanelClick);
$('#sheet').addEventListener('click', onPanelClick);
$('#content').addEventListener('input', (e) => {
  const key = { 'p-from': 'from', 'p-to': 'to' }[e.target.id];
  if (key) {
    plan[key] = null;
    const q = e.target.value.trim();
    const list = q.length < 2 ? [] : stopMatches(q, 6);
    $(`#${e.target.id}-s`).innerHTML = list.map((s) => `<button class="row pick" data-pick="${key}" data-stop="${s.i}"><span class="stop-icon">${iconSvg(s.rail ? 'train' : 'bus')}</span><span class="main"><b>${esc(s.name)}</b></span><span></span></button>`).join('');
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
  const onShape = new Map();
  for (const t of net.trips) {
    const s = net.patterns[t.pattern].shape;
    if (!onShape.has(s)) onShape.set(s, new Map());
    onShape.get(s).set(lineKey(routeOf(t)), t.route);
  }
  const lines = (set) => [...set].map((s) => ({
    type: 'Feature', geometry: { type: 'LineString', coordinates: net.shapes[s].coords },
    properties: { shape: s, routes: [...onShape.get(s).values()].join(',') },
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
  map.addSource('selected-stops', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
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
  map.addLayer({ id: 'selected', type: 'line', source: 'selected', filter: ['==', ['get', 'walk'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['case', ['==', ['get', 'rail'], 1], '#38424a', '#0a7cff'], 'line-width': 5, 'line-opacity': 0.9 } });
  map.addLayer({ id: 'selected-walk', type: 'line', source: 'selected', filter: ['==', ['get', 'walk'], 1], paint: { 'line-color': '#66736d', 'line-width': 3, 'line-dasharray': [1, 1.5] } });
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
    id: 'selected-stops', type: 'circle', source: 'selected-stops',
    paint: {
      'circle-radius': ['case', ['==', ['get', 'end'], 1], 6, 3.5],
      'circle-color': '#fff', 'circle-stroke-color': '#0a4f9e', 'circle-stroke-width': 2,
    },
  });
  if (hasGlyphs) map.addLayer({
    id: 'selected-names', type: 'symbol', source: 'selected-stops', filter: ['==', ['get', 'end'], 1],
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
    paint: { 'text-color': '#16324f', 'text-halo-color': '#fff', 'text-halo-width': 1.6 },
  });
  for (const kind of ['bus', 'train']) {
    map.addImage(`${kind}-on`, mapIcon(kind, '#ffffff'), { pixelRatio: 2 });
    map.addImage(`${kind}-off`, mapIcon(kind, '#59655f'), { pixelRatio: 2 });
  }
  map.addLayer({
    id: 'vehicles', type: 'circle', source: 'vehicles', filter: ['==', ['get', 'hide'], 0],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, ['case', ['==', ['get', 'rail'], 1], 6, 5], 13, ['case', ['==', ['get', 'rail'], 1], 15, 13]],
      'circle-color': ['case', ['==', ['get', 'live'], 1], ['get', 'color'], '#ffffff'],
      'circle-stroke-color': ['case', ['==', ['get', 'live'], 1], '#ffffff', '#8a948f'],
      'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'vehicle-icons', type: 'symbol', source: 'vehicles', minzoom: 8.5, filter: ['==', ['get', 'hide'], 0],
    layout: {
      'icon-image': ['concat', ['case', ['==', ['get', 'rail'], 1], 'train', 'bus'], ['case', ['==', ['get', 'live'], 1], '-on', '-off']],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 8.5, 0.42, 13, 0.82], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
  });
  if (hasGlyphs) map.addLayer({
    id: 'vehicle-labels', type: 'symbol', source: 'vehicles', minzoom: 11.5, filter: ['==', ['get', 'hide'], 0],
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, 1.7], 'text-allow-overlap': true },
    paint: { 'text-color': '#26302b', 'text-halo-color': '#fff', 'text-halo-width': 1.4 },
  });

  const pointer = (id) => {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  };
  ['vehicles', 'stops', 'stations', 'selected', 'selected-stops', 'bus-lines', 'rail-lines'].forEach(pointer);
  map.on('click', (e) => {
    const box = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
    const hit = map.queryRenderedFeatures(box, { layers: ['vehicles', 'selected-stops', 'stations', 'stops', 'selected', 'bus-lines', 'rail-lines'] });
    const f = hit.find((x) => x.layer.id === 'vehicles') || hit[0];
    if (!f) return;
    const id = f.layer.id;
    if (id === 'vehicles') selectTrip(f.properties.trip, String(f.properties.day));
    else if (id === 'selected') openLine(f.properties.line, { pattern: f.properties.pattern, day: sheet?.day || (view.kind === 'plan' ? plan.day : undefined) });
    else if (id === 'bus-lines' || id === 'rail-lines') {
      if (focus) return; // sotto una selezione la rete resta sullo sfondo
      const routes = [...new Set(hit.filter((x) => x.layer.id.endsWith('-lines')).flatMap((x) => String(x.properties.routes).split(',').map(Number)))];
      if (routes.length === 1) openLine(routes[0], { shape: f.properties.shape });
      else show({ kind: 'lines', routes });
    } else selectStop(f.properties.i);
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
  document.querySelector('.legend').insertAdjacentHTML('afterbegin', `<span>${iconSvg('bus')}Bus</span><span>${iconSvg('train')}Treno</span>`);
  refreshActive();
  await loadSavedLive().catch((e) => console.warn('ritardi salvati', e));
  pushVehicles();
  renderView();
  await poll();
  checkVersion();
  setInterval(pushVehicles, 1000);
  setInterval(refreshActive, 20000);
  setInterval(() => refreshIfStale(POLL_MS), 30000);
  setInterval(() => {
    if (view.kind !== 'search') renderView();
    if (sheet?.kind === 'trip') renderTripSheet();
  }, 15000);
}

if ('serviceWorker' in navigator && !params.has('nosw')) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('sw', e));

start().catch((e) => {
  console.error(e);
  $('#status').textContent = `Errore: ${e.message}`;
});
