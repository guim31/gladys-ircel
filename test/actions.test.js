// -----------------------------------------------------------------------------
// The buttons of the Configuration screen: find a station, check the stations.
// Every failure is thrown (shown in red), with its four languages.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/world.js';
import { BRUSSEL, GENT } from './helpers/network.js';
import { fold, searchStations } from '../src/catalog.js';

// A house in the centre of Namur.
const HOUSE = { selector: 'home', name: 'Maison', latitude: 50.4669, longitude: 4.8675 };

test('find by name, word starts only, sorted by name', async () => {
  const w = await createWorld({ houses: [HOUSE] });
  const ack = await w.gladys.fake.action('find_station', { query: 'gent' });
  assert.equal(ack.success, true, ack.error);
  assert.equal(
    ack.data.message.en,
    [
      'IRCEL-CELINE stations for "gent", to type in "Stations":',
      '#1207 Gent (44R701)',
      '#1715 Gent (G. Callierlaan) (44R702)',
      '#1732 Gent (Lange Violettestraat) (44R703)',
    ].join('\n'),
  );
  // Accents optional, codes too.
  const liege = await w.gladys.fake.action('find_station', { query: 'liege' });
  assert.match(liege.data.message.en, /Liège/);
  const code = await w.gladys.fake.action('find_station', { query: '44r701' });
  assert.match(code.data.message.en, /#1207 Gent/);
});

test('no name: the nearest stations to the house, with their distance', async () => {
  const w = await createWorld({ houses: [HOUSE] });
  const ack = await w.gladys.fake.action('find_station', {});
  const lines = ack.data.message.fr.split('\n');
  assert.equal(lines[0], "Stations d'IRCEL-CELINE autour de Maison, à saisir dans « Stations » :");
  assert.equal(lines[1], '#1733 Namur (43R401) (0.5 km)');
  assert.equal(lines.length, 10, 'the head, 8 stations, the tail');
  assert.match(lines.at(-1), /…et 131 autres : affinez la recherche\./);
  // The list is kept: a second search does not ask IRCEL again.
  await w.gladys.fake.action('find_station', { query: 'Gent' });
  assert.equal(w.network.calls.filter((call) => call === '/stations').length, 1);
});

test('nothing found: a success, saying so', async () => {
  const w = await createWorld();
  const ack = await w.gladys.fake.action('find_station', { query: 'Paris' });
  assert.equal(ack.success, true);
  assert.equal(ack.data.message.fr, "Aucune station d'IRCEL-CELINE pour « Paris ».");
});

test('no name and no located house: the action fails, saying what to do', async () => {
  const w = await createWorld({ houses: [{ selector: 'h', name: 'H' }] });
  const ack = await w.gladys.fake.action('find_station', {});
  assert.equal(ack.success, false);
  assert.match(ack.error.en, /Settings → Houses/);
  assert.match(ack.error.fr, /Paramètres → Maisons/);
});

test('the station list unreachable: the action fails with a clear message', async () => {
  const w = await createWorld({ setup: (network) => (network.down = true) });
  const ack = await w.gladys.fake.action('find_station', { query: 'Gent' });
  assert.equal(ack.success, false);
  assert.match(ack.error.en, /cannot be read now/);
  assert.match(ack.error.fr, /illisible/);
});

test('check the stations: level, pollutants, age, and the typos', async () => {
  const w = await createWorld({ config: { stations: `${GENT}, ${BRUSSEL}, abc` } });
  const ack = await w.gladys.fake.action('check_stations', {});
  assert.equal(ack.success, true, ack.error);
  assert.equal(
    ack.data.message.en,
    [
      '#1207 Gent: Fairly good, PM2.5, PM10, PM1, NO₂, O₃, BC (1 h ago)',
      '#1711 Brussel (Beliardstraat): Moderate, NO₂, CO, C₆H₆ (1 h ago)',
      'Ignored, not station numbers: abc',
    ].join('\n'),
  );
});

test('check the stations: nothing configured, or none answers, is a failure', async () => {
  const empty = await createWorld();
  const none = await empty.gladys.fake.action('check_stations', {});
  assert.equal(none.success, false);
  assert.equal(none.error.fr, "Aucune station n'est configurée.");

  const w = await createWorld({ config: { stations: GENT } });
  w.network.down = true;
  w.advance(3_600_000);
  const ack = await w.gladys.fake.action('check_stations', {});
  assert.equal(ack.success, false);
  assert.match(ack.error.fr, /^#1207 Gent : erreur \(IRCEL API unreachable/);
});

test('search helpers: folding and ordering', () => {
  assert.equal(fold('Liège (Jemeppe)'), 'liege (jemeppe)');
  const stations = [
    { id: '1', code: 'B1', name: 'B', lat: 50.5, lon: 4.9 },
    { id: '2', code: 'A1', name: 'A', lat: null, lon: null },
  ];
  assert.deepEqual(
    searchStations(stations, { query: '' }).map((s) => s.id),
    ['2', '1'],
  );
  assert.deepEqual(
    searchStations(stations, { origin: { lat: 50, lon: 4 } }).map((s) => s.id),
    ['1', '2'],
  );
});
