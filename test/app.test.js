// -----------------------------------------------------------------------------
// The integration end to end, on the SDK's fake Gladys and the real IRCEL
// answers: discovery, states, BelAQI, freshness, the container's own polling,
// the scene triggers, the status of the Configuration screen.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAll, createWorld, discovered, featureId } from './helpers/world.js';
import { BRUSSEL, GENT, LINKEROEVER, seriesAt } from './helpers/network.js';
import { MemoryStore } from '../src/store.js';
import { TEXT } from '../src/i18n.js';

const HOUR = 3_600_000;
const ALL = [GENT, BRUSSEL, LINKEROEVER].join(',');

test('one device per station, named after the IRCEL list, with what it measures', async () => {
  const w = await createWorld({ config: { stations: ALL } });
  const keys = (id) => discovered(w, id).features.map((f) => f.external_id.split(':').pop());
  assert.equal(discovered(w, GENT).name, 'IRCEL Gent (44R701)');
  // Gent: its benzene, CO and SO₂ series stopped years ago: no feature.
  assert.deepEqual(keys(GENT), [
    'index',
    'quality',
    'pm25',
    'pm10',
    'pm1',
    'no2',
    'o3',
    'bc',
    'age',
  ]);
  // Brussel, Beliardstraat: no particulate matter, CO given in mg/m³.
  assert.deepEqual(keys(BRUSSEL), ['index', 'quality', 'no2', 'co', 'c6h6', 'age']);
  assert.deepEqual(keys(LINKEROEVER), ['index', 'quality', 'pm25', 'pm10', 'age']);
  assert.equal(discovered(w, GENT).should_poll, false);
  assert.equal(discovered(w, GENT).features[0].name, 'Indice BelAQI');
  // Nothing is published for a device not added to Gladys.
  assert.deepEqual(w.gladys.fake.states, []);
  assert.deepEqual(w.gladys.fake.connectionStatus, { connected: true });
});

test('the states of an added station: BelAQI, its word, pollutants, age', async () => {
  const w = await createWorld({ config: { stations: ALL } });
  await createAll(w);
  const last = (id, key) => w.gladys.fake.lastState(featureId(w, id, key));
  // Gent: PM10 8.3 (1), PM2.5 5.2 (2), O₃ 47.5 (2), NO₂ 23 (4) -> 4.
  assert.equal(last(GENT, 'index'), 4);
  assert.equal(last(GENT, 'quality'), 'Assez bon');
  assert.equal(last(GENT, 'pm25'), 5.181);
  assert.equal(last(GENT, 'bc'), 0.905);
  assert.equal(last(GENT, 'age'), 80);
  // Brussel: NO₂ alone, 34.5 -> 35 (5); CO 0.445 mg/m³ -> 445 µg/m³.
  assert.equal(last(BRUSSEL, 'index'), 5);
  assert.equal(last(BRUSSEL, 'quality'), 'Moyen');
  assert.equal(last(BRUSSEL, 'co'), 445);
  assert.equal(last(LINKEROEVER, 'index'), 2);
  assert.ok(w.gladys.fake.widgetRefreshes.includes('air_quality'));
});

test('a device added again gets every state again, even unchanged', async () => {
  const w = await createWorld({ config: { stations: GENT } });
  await createAll(w);
  const before = w.gladys.fake.states.length;
  await w.gladys.fake.deviceCreated(discovered(w, GENT));
  assert.equal(w.gladys.fake.states.length - before, 9, 'index, quality, 6 pollutants, age');
});

test('an old value is never published as current, nor counted in the index', async () => {
  const w = await createWorld({ config: { stations: GENT } });
  w.advance(4 * HOUR); // IRCEL stuck on 19:00: the data are 5 h 20 old
  await createAll(w);
  const last = (key) => w.gladys.fake.lastState(featureId(w, GENT, key));
  assert.equal(last('pm25'), undefined);
  assert.equal(last('index'), undefined);
  assert.equal(last('age'), 320);
});

test('a missing value: the others and the index still go out', async () => {
  const w = await createWorld({
    config: { stations: GENT },
    setup: (network) => {
      network.series[GENT] = seriesAt(GENT, 0, { no2: null });
    },
  });
  await createAll(w);
  const last = (key) => w.gladys.fake.lastState(featureId(w, GENT, key));
  // No NO₂ value: nothing published for it, the index falls to the others.
  assert.equal(last('no2'), undefined);
  assert.equal(last('index'), 2);
  assert.equal(last('pm10'), 8.3);
});

test('the container reads the added stations on its own timer, not on onPoll', async () => {
  const w = await createWorld({ config: { stations: `${GENT},${BRUSSEL}` } });
  await w.gladys.fake.deviceCreated(discovered(w, GENT));
  const reads = (id) => w.network.calls.filter((call) => call.includes(`station=${id}&`)).length;
  const before = reads(GENT);
  // Within the period: nothing read again.
  w.advance(20 * 60_000);
  await w.app.poller.cycle();
  assert.equal(reads(GENT), before);
  // Past it: the added station only (Brussel was read once, for discovery).
  w.advance(10 * 60_000);
  await w.app.poller.cycle();
  assert.equal(reads(GENT), before + 1);
  assert.equal(reads(BRUSSEL), 1);
  // The station list is read once a day at most.
  assert.equal(w.network.calls.filter((call) => call === '/stations').length, 1);
});

test('scene triggers: degraded, worse, better but still degraded, back to normal', async () => {
  const w = await createWorld({ config: { stations: GENT, language: 'en' } });
  await createAll(w);
  // The first index sets the starting level: no event.
  assert.deepEqual(w.gladys.fake.sceneEvents, []);
  let hours = 0;
  const step = async (no2) => {
    hours += 1;
    w.network.series[GENT] = seriesAt(GENT, hours, { no2 });
    w.advance(HOUR);
    await w.app.poller.cycle();
  };
  await step(35); // 5, moderate
  await step(55); // 8, bad
  await step(42); // 6, poor
  await step(42); // 6 again, a new hour
  await step(25); // 4, fairly good
  await step(12); // 2, very good
  const events = w.gladys.fake.sceneEvents;
  assert.deepEqual(
    events.map((event) => [event.key, event.data.level]),
    [
      ['air_quality_degraded', 'moderate'],
      ['air_quality_degraded', 'bad'],
      ['air_quality_back_to_normal', 'fairly_good'],
    ],
  );
  const [first, , back] = events;
  assert.equal(first.data.station, discovered(w, GENT).external_id);
  assert.equal(first.data.station_name, 'IRCEL Gent (44R701)');
  assert.equal(first.data.level_label, 'Moderate');
  assert.equal(first.data.level_index, 5);
  assert.equal(first.data.previous_level_index, 4);
  assert.equal(first.data.pollutant, 'NO₂');
  assert.match(first.data.summary, /^IRCEL Gent \(44R701\): Moderate · PM2\.5 5\.2 µg\/m³/);
  assert.equal(back.data.worst_level, 'bad');
  assert.equal(back.data.worst_level_label, 'Bad');
  assert.equal(back.data.worst_level_index, 8);
});

test('the triggers name the pollutant that sets the level', async () => {
  const w = await createWorld({ config: { stations: GENT } });
  await createAll(w);
  w.network.series[GENT] = seriesAt(GENT, 1, { o3: 100 });
  w.advance(HOUR);
  await w.app.poller.cycle();
  assert.equal(w.gladys.fake.sceneEvents[0].data.pollutant, 'O₃');
});

test('no event for a station not added, nor twice after a restart', async () => {
  const store = new MemoryStore();
  const degraded = seriesAt(GENT, 0, { no2: 55 });
  const w = await createWorld({
    config: { stations: GENT },
    store,
    setup: (network) => {
      network.series[GENT] = degraded;
    },
  });
  await w.app.poller.refreshNow([GENT]);
  assert.deepEqual(w.gladys.fake.sceneEvents, []);
  await w.app.stop();

  // Restarted, the device now added: the same hour is not news.
  const again = await createWorld({
    config: { stations: GENT },
    store,
    devices: w.gladys.fake.discoveredDevices,
    setup: (network) => {
      network.series[GENT] = degraded;
    },
  });
  await again.app.poller.refreshNow([GENT]);
  assert.equal(again.gladys.fake.lastState(featureId(again, GENT, 'index')), 8);
  assert.deepEqual(again.gladys.fake.sceneEvents, []);
  // The device names and pollutants come back from /data, before any read.
  const offline = await createWorld({
    config: { stations: GENT },
    store,
    setup: (network) => {
      network.down = true;
    },
  });
  assert.equal(discovered(offline, GENT).features.length, 9);
});

test('a pollutant arriving late in the same hour still moves the triggers', async () => {
  const w = await createWorld({ config: { stations: GENT, language: 'en' } });
  await createAll(w);
  // 21:20: the 20:00 hour without its NO₂ yet: the 19:00 one (23) still counts.
  const partial = seriesAt(GENT, 1);
  for (const item of partial) {
    if (item.parameters.phenomenon.id === '8') {
      item.lastValue.timestamp -= HOUR;
    }
  }
  w.network.series[GENT] = partial;
  w.advance(HOUR);
  await w.app.poller.cycle();
  assert.equal(w.gladys.fake.lastState(featureId(w, GENT, 'index')), 4);
  assert.deepEqual(w.gladys.fake.sceneEvents, []);
  // 21:50: the NO₂ of the 20:00 hour, high: same hour, new level.
  w.network.series[GENT] = seriesAt(GENT, 1, { no2: 55 });
  w.advance(HOUR / 2);
  await w.app.poller.cycle();
  assert.deepEqual(
    w.gladys.fake.sceneEvents.map((event) => [event.key, event.data.level]),
    [['air_quality_degraded', 'bad']],
  );
});

test('a degradation is closed by "back to normal" even after an outage', async () => {
  const w = await createWorld({ config: { stations: GENT, language: 'en' } });
  await createAll(w);
  w.network.series[GENT] = seriesAt(GENT, 1, { no2: 55 });
  w.advance(HOUR);
  await w.app.poller.cycle();
  // Five hours without an answer, then a good hour.
  w.network.down = true;
  for (let i = 0; i < 5; i += 1) {
    w.advance(HOUR);
    await w.app.poller.cycle();
  }
  w.network.down = false;
  w.network.series[GENT] = seriesAt(GENT, 7, { no2: 12 });
  w.advance(HOUR);
  await w.app.poller.cycle();
  const events = w.gladys.fake.sceneEvents;
  assert.deepEqual(
    events.map((event) => event.key),
    ['air_quality_degraded', 'air_quality_back_to_normal'],
  );
  assert.equal(events[1].data.worst_level, 'bad');
});

test('the status: nothing configured, API down and back', async () => {
  const empty = await createWorld();
  assert.deepEqual(empty.gladys.fake.connectionStatus, {
    connected: false,
    message: TEXT.notConfigured,
  });

  const w = await createWorld({ config: { stations: GENT } });
  await createAll(w);
  w.network.down = true;
  w.advance(HOUR);
  await w.app.poller.cycle();
  assert.deepEqual(w.gladys.fake.connectionStatus, {
    connected: false,
    message: TEXT.apiUnreachable,
  });
  w.network.down = false;
  w.advance(HOUR);
  await w.app.poller.cycle();
  assert.deepEqual(w.gladys.fake.connectionStatus, { connected: true });
  // A server error says the same.
  w.network.series[GENT] = { status: 503 };
  w.advance(HOUR);
  await w.app.poller.cycle();
  assert.deepEqual(w.gladys.fake.connectionStatus.message, TEXT.apiUnreachable);
});

test('a station unknown to IRCEL gives no device, and the check says why', async () => {
  const w = await createWorld({ config: { stations: '999999' } });
  assert.deepEqual(w.gladys.fake.discoveredDevices, []);
  const ack = await w.gladys.fake.action('check_stations', {});
  assert.equal(ack.success, false);
  assert.equal(ack.error.en, '#999999: not an IRCEL-CELINE station (see "Find a station")');
});

test('onPoll, should the core call it, reads only a station that is due', async () => {
  const w = await createWorld({ config: { stations: GENT } });
  await createAll(w);
  const before = w.network.calls.length;
  await w.gladys.fake.poll(discovered(w, GENT));
  assert.equal(w.network.calls.length, before);
  w.advance(HOUR);
  await w.gladys.fake.poll(discovered(w, GENT));
  assert.ok(w.network.calls.length > before);
});

test('a device added days after the configuration fires nothing at once', async () => {
  const w = await createWorld({ config: { stations: GENT } });
  // Read once for the Discovery tab (index 4), then not read while not added.
  w.advance(48 * HOUR);
  w.network.series[GENT] = seriesAt(GENT, 48, { no2: 55 });
  await createAll(w);
  assert.equal(w.gladys.fake.lastState(featureId(w, GENT, 'index')), 8);
  assert.deepEqual(w.gladys.fake.sceneEvents, []);
  // From there, a change does fire.
  w.network.series[GENT] = seriesAt(GENT, 49, { no2: 70 });
  w.advance(HOUR);
  await w.app.poller.cycle();
  assert.deepEqual(
    w.gladys.fake.sceneEvents.map((event) => event.data.level),
    ['very_bad'],
  );
});

test('an event Gladys refused is sent at the next cycle, an event sent is not sent again', async () => {
  const store = new MemoryStore();
  const w = await createWorld({ config: { stations: GENT }, store });
  await createAll(w);
  const publish = w.gladys.publishSceneEvent.bind(w.gladys);
  let refuse = true;
  w.gladys.publishSceneEvent = async (...args) => {
    if (refuse) {
      refuse = false;
      throw new Error('HTTP 429');
    }
    return publish(...args);
  };
  const degraded = seriesAt(GENT, 1, { no2: 55 });
  w.network.series[GENT] = degraded;
  w.advance(HOUR);
  await w.app.poller.cycle();
  assert.deepEqual(w.gladys.fake.sceneEvents, []);
  w.advance(HOUR);
  await w.app.poller.cycle();
  assert.deepEqual(
    w.gladys.fake.sceneEvents.map((event) => event.key),
    ['air_quality_degraded'],
  );
  await w.app.stop();

  // Restarted on the same /data, the same hour: nothing new.
  const again = await createWorld({
    config: { stations: GENT },
    store,
    devices: w.gladys.fake.discoveredDevices,
    setup: (network) => {
      network.series[GENT] = degraded;
    },
  });
  again.advance(HOUR);
  await again.app.poller.refreshNow([GENT]);
  assert.deepEqual(again.gladys.fake.sceneEvents, []);
});

test('the station list refused: asked again after a pause, not by every station', async () => {
  const w = await createWorld({
    config: { stations: ALL },
    setup: (network) => {
      network.stations = { status: 503 };
    },
  });
  const lists = () => w.network.calls.filter((call) => call === '/stations');
  assert.equal(lists().length, 1);
  // The stations are read all the same, named by their number.
  assert.equal(discovered(w, GENT).name, 'IRCEL #1207');
  await createAll(w);
  assert.equal(lists().length, 1);
  w.network.stations = null;
  w.advance(HOUR);
  await w.app.poller.cycle();
  assert.equal(lists().length, 2);
  assert.equal(discovered(w, GENT).name, 'IRCEL Gent (44R701)');
});

test('an odd answer for one station spoils that station, not the others nor the status', async () => {
  const w = await createWorld({
    config: { stations: `${GENT},${BRUSSEL}` },
    setup: (network) => {
      network.series[BRUSSEL] = { status: 404 };
    },
  });
  await createAll(w);
  assert.equal(w.gladys.fake.lastState(featureId(w, GENT, 'pm25')), 5.181);
  assert.equal(discovered(w, BRUSSEL), undefined);
  assert.deepEqual(w.gladys.fake.connectionStatus, { connected: true });
});
