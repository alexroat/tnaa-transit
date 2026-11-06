// Logica pura sugli orari: calendario, corse attive, posizione lungo la shape. Nessun accesso al DOM.
const ROME = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function romeParts(ms) {
  const p = Object.fromEntries(ROME.formatToParts(ms).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}${p.month}${p.day}`, sec: +p.hour * 3600 + +p.minute * 60 + +p.second };
}

export function addDays(ymd, n) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + n));
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

const weekdayBit = (ymd) => {
  const js = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay();
  return 1 << ((js + 6) % 7); // lunedi = bit 0
};

export function serviceRuns(svc, ymd) {
  const [mask, start, end, added, removed] = svc;
  if (removed.includes(ymd)) return false;
  if (added.includes(ymd)) return true;
  return ymd >= start && ymd <= end && (mask & weekdayBit(ymd)) !== 0;
}

export class Network {
  constructor(raw) {
    this.stops = raw.stops.map(([id, name, lat, lon, rail], i) => ({ i, id, name, lat, lon, rail: !!rail }));
    this.routes = raw.routes.map(([id, short, long, color, rail, feed], i) => ({ i, id, short, long, color, rail: !!rail, feed }));
    this.services = raw.services;
    this.shapes = raw.shapes.map((flat) => buildShape(flat));
    this.patterns = raw.patterns.map(([shape, stops, dist, seqs]) => ({ shape, stops, dist, seqs }));
    this.offsets = raw.offsets;
    this.trips = raw.trips.map(([id, route, service, headsign, pattern, start, offsets, short], i) => ({
      i, id, route, service, headsign, pattern, start, offsets, short,
    }));
    this.generatedAt = raw.generatedAt;
    this.byStop = new Map();
    for (const t of this.trips) {
      this.patterns[t.pattern].stops.forEach((s, pos) => {
        let list = this.byStop.get(s);
        if (!list) this.byStop.set(s, (list = []));
        list.push([t.i, pos]);
      });
    }
    this.dayCache = new Map();
  }

  tripsOnDay(ymd) {
    let out = this.dayCache.get(ymd);
    if (!out) {
      const on = this.services.map((s) => serviceRuns(s, ymd));
      out = this.trips.filter((t) => on[t.service]);
      this.dayCache.set(ymd, out);
    }
    return out;
  }

  times(trip, pos) {
    const o = this.offsets[trip.offsets];
    return { arr: trip.start + o[pos * 2], dep: trip.start + o[pos * 2 + 1] };
  }

  endTime(trip) {
    const o = this.offsets[trip.offsets];
    return trip.start + o[o.length - 1];
  }

  /** Corse da considerare ora: inizio entro `lead` secondi, fine entro `lag` secondi fa. */
  candidates(nowMs, lead = 900, lag = 7200) {
    const { ymd, sec } = romeParts(nowMs);
    const out = [];
    for (const [day, s] of [[ymd, sec], [addDays(ymd, -1), sec + 86400]]) {
      for (const trip of this.tripsOnDay(day)) {
        if (trip.start - lead <= s && this.endTime(trip) + lag >= s) out.push({ trip, day, midnight: nowMs / 1000 - s });
      }
    }
    return out;
  }

  /**
   * Stato della corsa quando il ritardo vale `delay` secondi, o null se non e in viaggio.
   * Il mezzo sosta alla fermata fra arrivo e partenza e avanza linearmente fra due fermate.
   */
  locate(trip, nowSec, delay) {
    const pat = this.patterns[trip.pattern];
    const t = nowSec - delay;
    const n = pat.stops.length;
    if (t < this.times(trip, 0).dep || t > this.times(trip, n - 1).arr) return null;
    let i = 0;
    while (i < n - 2 && t >= this.times(trip, i + 1).arr) i++;
    const a = this.times(trip, i).dep;
    const b = this.times(trip, i + 1).arr;
    if (t >= this.times(trip, i + 1).arr && t <= this.times(trip, i + 1).dep) i++;
    const f = b > a ? Math.max(0, Math.min(1, (t - a) / (b - a))) : 1;
    const d = i < n - 1 && t <= b ? pat.dist[i] + f * (pat.dist[i + 1] - pat.dist[i]) : pat.dist[i];
    return { ...pointAt(this.shapes[pat.shape], d), nextPos: Math.min(i + 1, n - 1) };
  }
}

function buildShape(flat) {
  const coords = [];
  for (let i = 0; i < flat.length; i += 2) coords.push([flat[i], flat[i + 1]]);
  const cum = [0];
  const k = Math.cos((coords[0][1] * Math.PI) / 180) * 111320;
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + Math.hypot((coords[i][0] - coords[i - 1][0]) * k, (coords[i][1] - coords[i - 1][1]) * 110540));
  }
  return { coords, cum };
}

function pointAt(shape, d) {
  const { coords, cum } = shape;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (cum[m] <= d) lo = m;
    else hi = m;
  }
  const f = cum[hi] > cum[lo] ? Math.max(0, Math.min(1, (d - cum[lo]) / (cum[hi] - cum[lo]))) : 0;
  const [ax, ay] = coords[lo];
  const [bx, by] = coords[hi];
  return { lon: ax + f * (bx - ax), lat: ay + f * (by - ay) };
}
