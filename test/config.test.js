import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  MAX_STATIONS,
  normalizeConfig,
  parseStationIds,
  periodMs,
} from '../src/config.js';

test('the defaults read nothing, every 30 minutes, in French', () => {
  const config = normalizeConfig();
  assert.deepEqual(config.stationIds, []);
  assert.equal(config.refreshMinutes, 30);
  assert.equal(config.language, 'fr');
  assert.equal(DEFAULT_CONFIG.language, 'fr');
});

test('station ids: commas, spaces, semicolons and a "#" in front are accepted', () => {
  assert.deepEqual(parseStationIds(' 1207, #1711;1207  01030 '), {
    valid: ['1207', '1711', '1030'],
    invalid: [],
  });
  assert.deepEqual(parseStationIds('1207, Gent, 0, -4, 1.5'), {
    valid: ['1207'],
    invalid: ['Gent', '0', '-4', '1.5'],
  });
  assert.deepEqual(parseStationIds(''), { valid: [], invalid: [] });
});

test(`at most ${MAX_STATIONS} stations are read, the others are reported`, () => {
  const ids = Array.from({ length: MAX_STATIONS + 2 }, (_, index) => String(100 + index));
  const config = normalizeConfig({ stations: ids.join(',') });
  assert.equal(config.stationIds.length, MAX_STATIONS);
  assert.deepEqual(config.droppedStationIds, ids.slice(MAX_STATIONS));
});

test('the refresh interval is one of the offered values', () => {
  assert.equal(normalizeConfig({ refresh_minutes: '60' }).refreshMinutes, 60);
  assert.equal(normalizeConfig({ refresh_minutes: '5' }).refreshMinutes, 30);
  assert.equal(normalizeConfig({ refresh_minutes: 'often' }).refreshMinutes, 30);
  assert.equal(periodMs(normalizeConfig({ refresh_minutes: '60' })), 3_600_000);
});

test('an unknown language falls back to French', () => {
  assert.equal(normalizeConfig({ language: 'de' }).language, 'de');
  assert.equal(normalizeConfig({ language: 'pl' }).language, 'fr');
});
