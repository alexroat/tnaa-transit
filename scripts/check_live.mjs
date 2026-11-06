// Controlla sui feed veri quante corse live si agganciano agli orari di net.json. Da lanciare con il servizio attivo.
import { readFileSync } from 'node:fs';
import { Network } from '../app/js/schedule.js';
import { currentDelay, lookup, parseTripUpdates, stopDelays } from '../app/js/rt.js';

const headers = { 'X-BusOne-Client': 'tnttmonitor-poc', 'X-BusOne-Use': 'personal' };
const net = new Network(JSON.parse(readFileSync(new URL('../app/data/net.json', import.meta.url))));
const feeds = { tt: 'trentino', trn: 'trenitalia' };
const nowMs = Date.now();
const candidates = net.candidates(nowMs);

for (const [key, name] of Object.entries(feeds)) {
  const get = (f) => fetch(`https://proxy.busone.app/${name}/gtfs-rt/${f}.json`, { headers }).then((r) => r.json());
  const [tu, vp] = await Promise.all([get('trip-updates'), get('vehicle-positions')]);
  const rt = parseTripUpdates(tu);
  const ids = new Set(net.trips.map((t) => t.id));
  const known = (tu.entity || []).filter((e) => ids.has((e.tripUpdate || e.trip_update)?.trip?.tripId ?? e.trip_update?.trip?.trip_id)).length;
  const positions = new Map((vp.entity || []).map((e) => [e.vehicle?.trip?.tripId ?? e.vehicle?.trip?.trip_id, e.vehicle]));
  const gaps = [];
  let withDelay = 0;
  let sameStop = 0;
  let oneOff = 0;
  for (const c of candidates) {
    if (net.routes[c.trip.route].feed !== key) continue;
    const at = (i) => net.times(c.trip, i);
    const sec = nowMs / 1000 - c.midnight;
    const found = lookup(rt, c.trip.id, c.day);
    const rec = found && { ...found, midnight: c.midnight };
    const { seqs } = net.patterns[c.trip.pattern];
    const delays = stopDelays(rec, seqs, at, sec);
    const delay = currentDelay(rec, delays, at, sec);
    if (delay !== undefined) withDelay++;
    const p = net.locate(c.trip, sec, delay ?? 0);
    const v = positions.get(c.trip.id);
    if (p && v?.position) {
      const k = Math.cos((p.lat * Math.PI) / 180) * 111320;
      gaps.push(Math.hypot((p.lon - v.position.longitude) * k, (p.lat - v.position.latitude) * 110540));
      const step = Math.abs(seqs.indexOf(v.currentStopSequence ?? v.current_stop_sequence) - p.nextPos);
      if (step === 0) sameStop++;
      else if (step === 1) oneOff++;
    }
  }
  gaps.sort((a, b) => a - b);
  console.log(`${name}: ${tu.entity?.length ?? 0} TripUpdates, ${known} agganciati agli orari, ${withDelay} corse con ritardo`);
  if (gaps.length) console.log(`  distanza dalle posizioni BusOne su ${gaps.length} mezzi: mediana ${Math.round(gaps[gaps.length >> 1])} m, massimo ${Math.round(gaps.at(-1))} m; prossima fermata uguale ${sameStop}, a una fermata ${oneOff}`);
}
