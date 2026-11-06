// Lettura dei TripUpdates GTFS-RT in JSON, accettando sia camelCase sia snake_case. Logica pura.
const pick = (o, a, b) => (o ? (o[a] !== undefined ? o[a] : o[b]) : undefined);
const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

/** Ritorna Map "tripId|startDate" (e "tripId" come ripiego) -> { canceled, updates[] }. */
export function parseTripUpdates(feed) {
  const out = new Map();
  for (const e of feed.entity || []) {
    const tu = pick(e, 'tripUpdate', 'trip_update');
    if (!tu) continue;
    const trip = tu.trip || {};
    const id = pick(trip, 'tripId', 'trip_id');
    if (!id) continue;
    const rel = pick(trip, 'scheduleRelationship', 'schedule_relationship');
    const list = pick(tu, 'stopTimeUpdate', 'stop_time_update') || [];
    const updates = list.map((u) => {
      const a = u.arrival || {};
      const d = u.departure || {};
      return {
        seq: num(pick(u, 'stopSequence', 'stop_sequence')),
        stopId: pick(u, 'stopId', 'stop_id'),
        rel: pick(u, 'scheduleRelationship', 'schedule_relationship') || 'SCHEDULED',
        arrDelay: num(a.delay), arrTime: num(a.time),
        depDelay: num(d.delay), depTime: num(d.time),
      };
    });
    const rec = { canceled: rel === 'CANCELED' || rel === 'DELETED', updates, tripDelay: num(tu.delay) };
    const date = pick(trip, 'startDate', 'start_date');
    if (date) out.set(`${id}|${date}`, rec);
    out.set(id, rec);
  }
  return out;
}

export const lookup = (rt, tripId, day) => rt.get(`${tripId}|${day}`) || rt.get(tripId);

/**
 * Ritardi per fermata: array parallelo alle fermate del pattern (undefined = nessun dato).
 *
 * Sui bus BusOne indica anche per le fermate gia passate un orario schiacciato su "adesso": il ritardo che ne
 * risulta e un artefatto (anche +77 min con la corsa quasi in orario). Quando il feed da il ritardo della corsa
 * si tengono quindi solo le fermate ancora da raggiungere.
 */
export function stopDelays(rec, seqs, schedAt, nowSec) {
  const res = new Array(seqs.length).fill(undefined);
  if (!rec) return res;
  const pos = new Map(seqs.map((s, i) => [s, i]));
  for (const u of rec.updates) {
    const i = pos.get(u.seq);
    if (i === undefined || u.rel === 'NO_DATA' || u.rel === 'NO DATA') continue;
    const { arr, dep } = schedAt(i);
    if (rec.tripDelay !== undefined && dep + rec.tripDelay < nowSec) continue;
    const a = u.arrDelay ?? (u.arrTime !== undefined ? u.arrTime - arr - rec.midnight : undefined);
    const d = u.depDelay ?? (u.depTime !== undefined ? u.depTime - dep - rec.midnight : undefined);
    res[i] = { arr: a ?? d, dep: d ?? a, skipped: u.rel === 'SKIPPED' };
  }
  return res;
}

/** Ritardo attuale: quello della corsa se il feed lo da, altrimenti l'ultimo evento avvenuto o la prima previsione. */
export function currentDelay(rec, delays, schedAt, nowSec) {
  if (rec?.tripDelay !== undefined) return rec.tripDelay;
  let passed;
  let first;
  for (let i = 0; i < delays.length; i++) {
    const x = delays[i];
    if (!x || x.skipped) continue;
    first ??= x.dep;
    if (schedAt(i).dep + x.dep <= nowSec) passed = x.dep;
  }
  return passed ?? first;
}
