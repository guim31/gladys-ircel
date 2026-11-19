// -----------------------------------------------------------------------------
// The IRCEL-CELINE client against the real answers recorded on 2026-11-19
// (test/fixtures/ircel), and the BelAQI grid.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, fetchSeries, fetchStations, splitLabel } from '../src/api.js';
import { computeIndex, subIndex } from '../src/belaqi.js';
import { BRUSSEL, DATA_AT, GENT, LINKEROEVER, createNetwork } from './helpers/network.js';

const deps = () => {
  const network = createNetwork();
  return { network, deps: { fetch: network.fetch } };
};

test('the station list: ids, codes, names and coordinates', async () => {
  const { deps: d, network } = deps();
  const stations = await fetchStations(d);
  assert.equal(stations.length, 139);
  assert.deepEqual(
    stations.find((station) => station.id === GENT),
    { id: '1207', code: '44R701', name: 'Gent', lat: 51.058448335958275, lon: 3.729253787364104 },
  );
  assert.ok(
    stations.every((station) => station.code !== ''),
    'every label has a code',
  );
  assert.deepEqual(network.calls, ['/stations']);
});

test('labels: the code and the name, even with a dash missing its spaces', () => {
  assert.deepEqual(splitLabel('40AL01 - Linkeroever'), { code: '40AL01', name: 'Linkeroever' });
  assert.deepEqual(splitLabel('TOP3M1 -Antwerpen (Neerstraat)'), {
    code: 'TOP3M1',
    name: 'Antwerpen (Neerstraat)',
  });
  assert.deepEqual(splitLabel('44EG08- Evergem'), { code: '44EG08', name: 'Evergem' });
  assert.deepEqual(splitLabel('43N063 - Corroy-Le-Grand'), {
    code: '43N063',
    name: 'Corroy-Le-Grand',
  });
});

test('the series: our pollutants only, in µg/m³, with their last value', async () => {
  const { deps: d, network } = deps();
  const gent = await fetchSeries(GENT, d);
  // Weather, NO and the like are left out; old series are kept (the hub sorts).
  assert.deepEqual(
    gent.map((item) => item.pollutant),
    ['c6h6', 'bc', 'co', 'no2', 'o3', 'pm1', 'pm10', 'pm25', 'so2'],
  );
  assert.deepEqual(gent.find((item) => item.pollutant === 'no2').last, {
    value: 23,
    at: DATA_AT,
  });
  // CO comes in mg/m³: converted, without float noise.
  const brussel = await fetchSeries(BRUSSEL, d);
  assert.equal(brussel.find((item) => item.pollutant === 'co').last.value, 445);
  assert.equal((await fetchSeries(LINKEROEVER, d)).length, 2);
  assert.deepEqual(network.calls[0], `/timeseries?station=${GENT}&expanded=true`);
  // An unknown station: an empty list.
  assert.deepEqual(await fetchSeries('999999', d), []);
});

test('a series without last value has last: null', async () => {
  const network = createNetwork();
  network.series[GENT] = [
    {
      id: '1',
      uom: 'µg/m³',
      parameters: { phenomenon: { id: '8' } },
      lastValue: { timestamp: DATA_AT, value: null },
    },
  ];
  assert.deepEqual(await fetchSeries(GENT, { fetch: network.fetch }), [
    { id: '1', pollutant: 'no2', last: null },
  ]);
});

test('errors: unreachable, HTTP error, unreadable answer', async () => {
  const network = createNetwork();
  const d = { fetch: network.fetch };
  network.down = true;
  await assert.rejects(fetchStations(d), (err) => err instanceof ApiError && err.unreachable);
  network.down = false;
  // A server error is the service down, like no answer; a 404 is one station.
  network.series[GENT] = { status: 503 };
  await assert.rejects(fetchSeries(GENT, d), (err) => err.status === 503 && err.unreachable);
  network.series[GENT] = { status: 404 };
  await assert.rejects(fetchSeries(GENT, d), (err) => err.status === 404 && !err.unreachable);
  network.series[GENT] = { odd: true };
  await assert.rejects(fetchSeries(GENT, d), /no series list/);
});

test('BelAQI sub-indexes: the bounds of the official hourly grid', () => {
  // PM10: 0-10 is 1, 11-20 is 2; a value is rounded to the unit first.
  assert.equal(subIndex('pm10', 10.4), 1);
  assert.equal(subIndex('pm10', 10.6), 2);
  assert.equal(subIndex('pm10', 140), 9);
  assert.equal(subIndex('pm10', 141), 10);
  // PM2.5: one decimal.
  assert.equal(subIndex('pm25', 3.5), 1);
  assert.equal(subIndex('pm25', 3.6), 2);
  assert.equal(subIndex('pm25', 75.1), 10);
  assert.equal(subIndex('o3', 181), 8);
  assert.equal(subIndex('no2', 45), 6);
  assert.equal(subIndex('no2', -3), 1, 'analyser noise below zero');
  assert.equal(subIndex('so2', 10), null, 'not in the index');
  assert.equal(subIndex('no2', null), null);
});

test('BelAQI: the worst sub-index, null without any of the four', () => {
  assert.deepEqual(computeIndex({ pm10: 8.3, pm25: 5.181, o3: 47.5, no2: 23, bc: 0.9 }), {
    level: 4,
    subIndexes: { pm10: 1, pm25: 2, o3: 2, no2: 4 },
  });
  assert.equal(computeIndex({ co: 445 }), null);
});
