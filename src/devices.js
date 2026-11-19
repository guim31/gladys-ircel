// -----------------------------------------------------------------------------
// The Gladys devices: one per IRCEL-CELINE station.
//
// External ids (forever, see CLAUDE.md):
//   ext:<selector>:station:<IRCEL station id>
//   features :index, :quality, :pm25, :pm10, :pm1, :no2, :o3, :so2, :co,
//            :bc, :c6h6, :age
//
// Features:
//   - index   : the BelAQI index, `airquality-sensor/aqi`, 1 (excellent) to 10
//               (horrible), computed from the hourly means (src/belaqi.js).
//               No state while the station has none of PM10, PM2.5, O₃, NO₂;
//   - quality : the level as a word, in the configured language (text/text);
//   - the pollutants the station measures, hourly means in µg/m³. PM2.5, PM10,
//     NO₂, O₃ and SO₂ have their Gladys category. PM1, black carbon, CO and
//     benzene have none in µg/m³ (`co-sensor` is a binary detector in ppm,
//     `voc-sensor` is in ppb): they are `unknown/unknown` features, which
//     Gladys shows as a number with its unit, named by their formula. CO,
//     published by IRCEL in mg/m³, is converted to µg/m³;
//   - age     : minutes since the hour the last data refer to.
//
// The pollutants are learnt from the station's series (a series that gave a
// value in the last 30 days), kept under /data, and never removed: a feature
// is an external id Gladys keeps.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import { NAMES } from './i18n.js';

/** The pollutants, in display order. */
export const POLLUTANTS = ['pm25', 'pm10', 'pm1', 'no2', 'o3', 'so2', 'co', 'bc', 'c6h6'];

export const INDEX_KEY = 'index';
export const QUALITY_KEY = 'quality';
export const AGE_KEY = 'age';

const DEVICE_TYPE = 'station';

const concentration = (category, type, max) => ({
  category,
  type,
  unit: UNITS.MICROGRAM_PER_CUBIC_METER,
  min: 0,
  max,
  keep_history: true,
});

// min/max are display bounds (Gladys never clamps a state with them).
const SHAPES = {
  index: {
    category: CATEGORIES.AIRQUALITY_SENSOR,
    type: TYPES.AIRQUALITY_SENSOR.AQI,
    unit: UNITS.AQI,
    min: 1,
    max: 10,
    keep_history: true,
  },
  quality: {
    category: CATEGORIES.TEXT,
    type: TYPES.TEXT.TEXT,
    min: 0,
    max: 0,
    keep_history: false,
  },
  pm25: concentration(CATEGORIES.PM25_SENSOR, TYPES.SENSOR.DECIMAL, 500),
  pm10: concentration(CATEGORIES.PM10_SENSOR, TYPES.SENSOR.DECIMAL, 500),
  pm1: concentration(CATEGORIES.UNKNOWN, TYPES.UNKNOWN.UNKNOWN, 500),
  no2: concentration(CATEGORIES.NO2_SENSOR, TYPES.SENSOR.DECIMAL, 500),
  o3: concentration(CATEGORIES.O3_SENSOR, TYPES.SENSOR.DECIMAL, 500),
  so2: concentration(CATEGORIES.SO2_SENSOR, TYPES.SENSOR.DECIMAL, 500),
  co: concentration(CATEGORIES.UNKNOWN, TYPES.UNKNOWN.UNKNOWN, 20000),
  bc: concentration(CATEGORIES.UNKNOWN, TYPES.UNKNOWN.UNKNOWN, 50),
  c6h6: concentration(CATEGORIES.UNKNOWN, TYPES.UNKNOWN.UNKNOWN, 50),
  // A week on the scale; an older measurement still gets its real age.
  age: {
    category: CATEGORIES.DURATION,
    type: TYPES.DURATION.INTEGER,
    unit: UNITS.MINUTES,
    min: 0,
    max: 10080,
    keep_history: false,
  },
};

/**
 * The external ids of a station.
 * @param {object} gladys
 * @param {string} stationId
 */
export function idsOf(gladys, stationId) {
  return gladys.externalIds(DEVICE_TYPE, String(stationId));
}

/** The IRCEL station id of a device (or feature) external id, or null. */
export function stationIdOf(externalId) {
  const match = /:station:(\d+)(?::[a-z0-9]+)?$/.exec(String(externalId ?? ''));
  return match ? match[1] : null;
}

/**
 * The device name: the network, the station and its code (several stations
 * share a town name: three "Beveren"), never translated.
 */
export function deviceName(record) {
  if (!record.name) {
    return `IRCEL #${record.id}`;
  }
  return record.code ? `IRCEL ${record.name} (${record.code})` : `IRCEL ${record.name}`;
}

/** The pollutants of a record, in display order. */
export function pollutantsOf(record) {
  return POLLUTANTS.filter((key) => (record.pollutants ?? []).includes(key));
}

/**
 * The discovery payload of a station.
 * @param {object} gladys
 * @param {{ id: string, name?: string, pollutants?: string[] }} record
 * @param {string} language language of the feature names
 */
export function buildDevice(gladys, record, language) {
  const names = NAMES[language] ?? NAMES.fr;
  const ids = idsOf(gladys, record.id);
  const feature = (key) => ({
    name: names[key],
    external_id: ids.feature(key),
    ...SHAPES[key],
    read_only: true,
    has_feedback: false,
  });
  return {
    name: deviceName(record),
    external_id: ids.device,
    model: 'IRCEL-CELINE',
    // IRCEL publishes hourly: the container reads the stations on its own
    // timer (src/poller.js), well beyond the 60 s the core can schedule.
    should_poll: false,
    features: [
      feature(INDEX_KEY),
      feature(QUALITY_KEY),
      ...pollutantsOf(record).map(feature),
      feature(AGE_KEY),
    ],
    params: [{ name: 'station_id', value: String(record.id) }],
  };
}
