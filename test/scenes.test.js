// -----------------------------------------------------------------------------
// The scene action "Get the air quality": one station, or the worst one.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAll, createWorld, discovered } from './helpers/world.js';
import { BRUSSEL, GENT, LINKEROEVER } from './helpers/network.js';

async function world(language = 'fr') {
  const w = await createWorld({
    config: { stations: [GENT, BRUSSEL, LINKEROEVER].join(','), language },
  });
  await createAll(w);
  return w;
}

test('one station: its level, values and a sentence', async () => {
  const w = await world('en');
  const ack = await w.gladys.fake.sceneAction('get_air_quality', {
    station: discovered(w, GENT).external_id,
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs ?? ack.data, {
    station_name: 'IRCEL Gent (44R701)',
    level: 'fairly_good',
    level_index: 4,
    level_label: 'Fairly good',
    pm25: 5.181,
    pm10: 8.3,
    no2: 23,
    o3: 47.5,
    age_minutes: 80,
    summary:
      'IRCEL Gent (44R701): Fairly good · PM2.5 5.2 µg/m³ · PM10 8.3 µg/m³ · NO₂ 23 µg/m³ · O₃ 47.5 µg/m³',
  });
});

test('no station chosen: the worst index, and what sets it', async () => {
  const w = await world();
  const ack = await w.gladys.fake.sceneAction('get_air_quality', {});
  const outputs = ack.data.outputs ?? ack.data;
  assert.equal(outputs.station_name, 'IRCEL Brussel (Beliardstraat) (41B008)');
  assert.equal(outputs.level_label, 'Moyen');
  assert.equal(outputs.pm25, undefined, 'not measured: left out');
  assert.equal(outputs.no2, 34.5);
  assert.equal(outputs.pollutant, 'NO₂');
});

test('nothing recent: the action fails with a message in four languages', async () => {
  const w = await world();
  w.advance(5 * 3_600_000);
  const ack = await w.gladys.fake.sceneAction('get_air_quality', {});
  assert.equal(ack.success, false);
  assert.equal(ack.error.en, 'No air quality reading yet.');
  assert.equal(ack.error.fr, "Pas encore de relevé de la qualité de l'air.");
});
