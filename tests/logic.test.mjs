import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Network, addDays, romeParts, serviceRuns } from '../app/js/schedule.js';
import { currentDelay, lookup, parseTripUpdates, stopDelays } from '../app/js/rt.js';

test('calendario: maschera, eccezioni e intervallo', () => {
  const svc = [1, '20260101', '20261231', ['20261107'], ['20261102']]; // solo lunedi
  assert.equal(serviceRuns(svc, '20261109'), true);
  assert.equal(serviceRuns(svc, '20261110'), false);
  assert.equal(serviceRuns(svc, '20261102'), false); // lunedi rimosso
  assert.equal(serviceRuns(svc, '20261107'), true); // sabato aggiunto
  assert.equal(serviceRuns(svc, '20270104'), false);
});

test('fuso di Roma e cambio data', () => {
  assert.deepEqual(romeParts(Date.UTC(2026, 10, 5, 23, 30)), { ymd: '20261106', sec: 1800 });
  assert.deepEqual(romeParts(Date.UTC(2026, 6, 1, 22, 0)), { ymd: '20260702', sec: 0 });
  assert.equal(addDays('20260301', -1), '20260228');
});

const raw = {
  stops: [['a', 'A', 46, 11, 0], ['b', 'B', 46, 11.01, 0], ['c', 'C', 46, 11.02, 0]],
  routes: [['r', '1', 'Uno', '', 0, 'tt']],
  services: [[127, '20260101', '20271231', [], []]],
  shapes: [[11, 46, 11.01, 46, 11.02, 46]],
  patterns: [[0, [0, 1, 2], [0, 773, 1546], [1, 2, 3]]],
  offsets: [[0, 0, 600, 660, 1200, 1200]],
  trips: [['T', 0, 0, 'C', 0, 36000, 0, '']],
};

test('posizione: partenza, tratta, sosta e fine corsa', () => {
  const n = new Network(raw);
  const t = n.trips[0];
  assert.equal(n.locate(t, 35999, 0), null);
  assert.ok(Math.abs(n.locate(t, 36300, 0).lon - 11.005) < 1e-3); // meta della prima tratta
  assert.ok(Math.abs(n.locate(t, 36630, 0).lon - 11.01) < 1e-3); // in sosta a B
  assert.ok(Math.abs(n.locate(t, 36960, 0).lon - 11.015) < 1e-3); // meta della seconda tratta
  assert.ok(Math.abs(n.locate(t, 36300 + 300, 300).lon - 11.005) < 1e-3); // col ritardo resta indietro
  assert.equal(n.locate(t, 37201, 0), null);
});

test('TripUpdates snake_case, camelCase, NO_DATA e tempo assoluto', () => {
  const rt = parseTripUpdates({ entity: [
    { tripUpdate: { trip: { tripId: 'T', startDate: '20261106', scheduleRelationship: 'SCHEDULED' }, stopTimeUpdate: [
      { stopSequence: 1, scheduleRelationship: 'NO_DATA' },
      { stopSequence: 2, arrival: { delay: 120 }, departure: { delay: 180, time: '1' } },
      { stopSequence: 3, arrival: { time: '37320' } },
    ] } },
    { trip_update: { trip: { trip_id: 'X', schedule_relationship: 'CANCELED' }, stop_time_update: [] } },
  ] });
  assert.equal(lookup(rt, 'X', '20261106').canceled, true);
  const n = new Network(raw);
  const at = (i) => n.times(n.trips[0], i);
  const d = stopDelays({ ...lookup(rt, 'T', '20261106'), midnight: 0 }, [1, 2, 3], at, 0);
  assert.equal(d[0], undefined);
  assert.deepEqual(d[1], { arr: 120, dep: 180, skipped: false });
  assert.equal(d[2].arr, 120);
  const rec = lookup(rt, 'T', '20261106');
  assert.equal(currentDelay(rec, d, at, 36000), 180); // prima previsione
  assert.equal(currentDelay(rec, d, at, 36900), 180); // ultimo evento passato
});

test('bus: le fermate passate schiacciate su adesso non diventano ritardo', () => {
  // Forma reale del feed Trentino: il ritardo vero e nel campo delay della corsa.
  const rt = parseTripUpdates({ entity: [{ trip_update: { trip: { trip_id: 'T' }, delay: 60, stop_time_update: [
    { stop_sequence: 1, departure: { delay: 660, time: 36660 } },
    { stop_sequence: 2, departure: { delay: 120, time: 36780 } },
    { stop_sequence: 3, arrival: { delay: 60, time: 37260 } },
  ] } }] });
  const n = new Network(raw);
  const at = (i) => n.times(n.trips[0], i);
  const rec = { ...lookup(rt, 'T', '20261106'), midnight: 0 };
  const d = stopDelays(rec, [1, 2, 3], at, 36660);
  assert.equal(currentDelay(rec, d, at, 36660), 60);
  assert.equal(d[0], undefined); // fermata 1 gia passata: scartata
  assert.equal(d[1].dep, 120);
  assert.equal(d[2].arr, 60);
});

test('tempo assoluto: il ritardo tiene conto della mezzanotte', () => {
  const midnight = 1793800000;
  const rt = parseTripUpdates({ entity: [{ tripUpdate: { trip: { tripId: 'T' }, stopTimeUpdate: [
    { stopSequence: 3, arrival: { time: String(midnight + 37320) } },
  ] } }] });
  const n = new Network(raw);
  const d = stopDelays({ ...rt.get('T'), midnight }, [1, 2, 3], (i) => n.times(n.trips[0], i), 0);
  assert.equal(d[2].arr, 120);
});

test('dati reali: feed Trenitalia salvato combacia con net.json', { skip: !process.env.RT_SAMPLE }, () => {
  const net = new Network(JSON.parse(readFileSync('app/data/net.json', 'utf8')));
  const rt = parseTripUpdates(JSON.parse(readFileSync(process.env.RT_SAMPLE, 'utf8')));
  assert.ok(rt.size > 0);
  const ids = new Set(net.trips.map((t) => t.id));
  console.log('corse nel feed', rt.size, 'presenti in net', [...rt.keys()].filter((k) => ids.has(k)).length);
});

test('pianificatore: rete minima con un cambio e un tratto a piedi', async () => {
  const { Planner } = await import('../app/js/planner.js');
  const raw = {
    stops: [['a', 'A', 46, 11, 0], ['b', 'B', 46, 11.1, 0], ['c', 'C', 46.001, 11.1, 0], ['d', 'D', 46, 11.2, 0]],
    routes: [['r1', '1', 'Uno', '', 0, 'tt'], ['r2', '2', 'Due', '', 0, 'tt']],
    services: [[127, '20260101', '20261231', [], []]],
    shapes: [[11, 46, 11.2, 46]],
    patterns: [[0, [0, 1], [0, 1], [1, 2]], [0, [2, 3], [0, 1], [1, 2]]],
    offsets: [[0, 0, 600, 600]],
    trips: [['t1', 0, 0, 'B', 0, 28800, 0, ''], ['t2', 1, 0, 'D', 1, 29400, 0, ''], ['t3', 1, 0, 'D', 1, 29700, 0, '']],
    generatedAt: '',
  };
  const net = new Network(raw);
  const out = new Planner(net).plan(0, 3, '20261106', 28000);
  assert.equal(out.length, 1);
  assert.equal(out[0].transfers, 1);
  assert.equal(out[0].arr, 30300); // la t2 e troppo vicina: 120 s di cambio piu 100 m a piedi
  assert.equal(out[0].legs.filter((l) => l.walk).length, 1);
});
