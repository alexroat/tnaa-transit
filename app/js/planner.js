// Pianificatore su orari programmati: Connection Scan a round, un round per ogni mezzo preso. Logica pura.
const WALK_RADIUS_M = 300;
const WALK_SPEED_MS = 1.1;
const MIN_TRANSFER_S = 120;
const MAX_RIDES = 5;
const ROUND_LIMIT = 8;
const SEARCH_WINDOW_S = 4 * 3600;

function metres(a, b) {
  const x = (b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  const y = (b.lat - a.lat) * 110540;
  return Math.hypot(x, y);
}

export class Planner {
  constructor(net) {
    this.net = net;
    this.days = new Map();
    this.near = net.stops.map(() => []);
    const cell = 0.004;
    const grid = new Map();
    const key = (s) => `${Math.floor(s.lat / cell)}|${Math.floor(s.lon / cell)}`;
    for (const s of net.stops) {
      const k = key(s);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(s);
    }
    for (const s of net.stops) {
      const la = Math.floor(s.lat / cell);
      const lo = Math.floor(s.lon / cell);
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          for (const o of grid.get(`${la + i}|${lo + j}`) || []) {
            if (o.i === s.i) continue;
            const d = metres(s, o);
            if (d <= WALK_RADIUS_M) this.near[s.i].push([o.i, Math.round(d / WALK_SPEED_MS)]);
          }
        }
      }
    }
  }

  connections(ymd) {
    let c = this.days.get(ymd);
    if (c) return c;
    const list = [];
    for (const t of this.net.tripsOnDay(ymd)) {
      const stops = this.net.patterns[t.pattern].stops;
      for (let i = 0; i + 1 < stops.length; i++) {
        if (stops[i] === stops[i + 1]) continue;
        list.push([this.net.times(t, i).dep, this.net.times(t, i + 1).arr, stops[i], stops[i + 1], t.i, i]);
      }
    }
    list.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[5] - b[5]);
    c = list;
    if (this.days.size >= 3) this.days.clear();
    this.days.set(ymd, c);
    return c;
  }

  scan(from, to, conns, start) {
    const n = this.net.stops.length;
    const boarded = new Int32Array(this.net.trips.length);
    const base = new Float64Array(n).fill(Infinity);
    base[from] = start;
    for (const [s, w] of this.near[from]) base[s] = start + w;
    const rounds = [{ arr: base }];
    let lo = 0;
    let hi = conns.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (conns[m][0] < start) lo = m + 1;
      else hi = m;
    }
    for (let r = 1; r <= MAX_RIDES; r++) {
      const prev = rounds[r - 1].arr;
      const arr = Float64Array.from(prev);
      const enter = new Int32Array(n).fill(-1);
      const exit = new Int32Array(n).fill(-1);
      const foot = new Int32Array(n).fill(-1);
      const wait = r === 1 ? 0 : MIN_TRANSFER_S;
      const changed = new Set();
      boarded.fill(-1);
      for (let i = lo; i < conns.length; i++) {
        const c = conns[i];
        if (boarded[c[4]] < 0) {
          if (prev[c[2]] + wait > c[0]) continue;
          boarded[c[4]] = i;
        }
        if (c[1] < arr[c[3]]) {
          arr[c[3]] = c[1];
          enter[c[3]] = boarded[c[4]];
          exit[c[3]] = i;
          changed.add(c[3]);
        }
      }
      for (const s of changed) {
        for (const [o, w] of this.near[s]) {
          if (arr[s] + w < arr[o]) {
            arr[o] = arr[s] + w;
            enter[o] = -1;
            foot[o] = s;
          }
        }
      }
      rounds.push({ arr, enter, exit, foot });
      if (!changed.size) break;
    }
    const found = [];
    let best = Infinity;
    for (let r = 1; r < rounds.length; r++) {
      if (rounds[r].arr[to] < best) {
        best = rounds[r].arr[to];
        found.push(this.rebuild(from, to, r, rounds, conns));
      }
    }
    return found;
  }

  rebuild(from, to, rides, rounds, conns) {
    const legs = [];
    let s = to;
    let r = rides;
    while (r > 0) {
      const { enter, exit, foot } = rounds[r];
      if (enter[s] >= 0) {
        const a = conns[enter[s]];
        const b = conns[exit[s]];
        legs.unshift({ trip: a[4], fromPos: a[5], toPos: b[5] + 1, from: a[2], to: b[3], dep: a[0], arr: b[1] });
        s = a[2];
        r--;
      } else if (foot[s] >= 0) {
        legs.unshift({ walk: true, from: foot[s], to: s });
        s = foot[s];
      } else r--;
    }
    if (s !== from) legs.unshift({ walk: true, from, to: s });
    const ride = legs.filter((l) => !l.walk);
    return { legs, dep: ride[0].dep, arr: rounds[rides].arr[to], transfers: ride.length - 1 };
  }

  /** Viaggi non dominati dal momento `sec` del giorno `ymd`, al massimo `limit`. */
  plan(from, to, ymd, sec, limit = 5) {
    if (from === to) return [];
    const conns = this.connections(ymd);
    const seen = new Map();
    let cursor = sec;
    for (let i = 0; i < ROUND_LIMIT; i++) {
      const found = this.scan(from, to, conns, cursor);
      if (!found.length) break;
      for (const j of found) seen.set(j.legs.map((l) => (l.walk ? 'w' : `${l.trip}:${l.fromPos}`)).join('>'), j);
      cursor = Math.min(...found.map((j) => j.dep)) + 60;
      if (cursor > sec + SEARCH_WINDOW_S) break;
    }
    const all = [...seen.values()];
    const beaten = (a, b) => a !== b && b.dep >= a.dep && b.arr <= a.arr && b.transfers <= a.transfers
      && (b.dep > a.dep || b.arr < a.arr || b.transfers < a.transfers);
    return all.filter((a) => !all.some((b) => beaten(a, b))).sort((a, b) => a.arr - b.arr || a.dep - b.dep).slice(0, limit);
  }
}
