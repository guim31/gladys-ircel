// -----------------------------------------------------------------------------
// The stations the integration reads, what it knows about them, and what it
// publishes to Gladys.
//
// Reading a station (refresh) updates its "record" — name, code, the
// pollutants it measures, the last value of each — persisted under /data; the
// record gives the Gladys device (src/devices.js) and its states. The BelAQI
// index is computed from the fresh values (src/belaqi.js).
//
// Freshness: IRCEL publishes hourly means, about an hour after the hour. A
// value older than STALE_MINUTES is NOT published (nor sent again by the
// heartbeat), and leaves the index: a value Gladys shows as recent is a recent
// measurement. Only the age keeps moving.
//
// Scene triggers, on each new index (a newer hour of its pollutants):
//   air_quality_degraded       the index rises to "moderate" (5) or worse;
//   air_quality_back_to_normal it comes back to "fairly good" or better (≤ 4).
// The first index after the install sets the starting level, without event.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { ApiError, fetchSeries } from './api.js';
import { INDEX_POLLUTANTS, computeIndex } from './belaqi.js';
import { Catalog } from './catalog.js';
import {
  AGE_KEY,
  INDEX_KEY,
  POLLUTANTS,
  QUALITY_KEY,
  buildDevice,
  deviceName,
  idsOf,
  pollutantsOf,
  stationIdOf,
} from './devices.js';
import { createIssueLog } from './issues.js';
import { FORMULAS, LEVELS, MESSAGES, levelKey } from './i18n.js';

const logger = createLogger({ name: 'stations' });

/** Past this age, a value is stale: not published, and the widget says so. */
export const STALE_MINUTES = 180;

/** An unchanged value is published again this often (Gladys: "no recent value" past 48 h). */
export const STATE_HEARTBEAT_MS = 6 * 60 * 60 * 1000;

/**
 * A series becomes a feature when its last value is this recent: IRCEL keeps
 * the series of instruments removed years ago (benzene at Gent, last value in
 * 2015), which must not become dead features.
 */
const ACTIVE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A level seen longer ago than this is no reference for a scene event: the
 * station was not read meanwhile (device added days after the configuration,
 * container stopped), and the next index starts afresh, without event.
 */
const ANNOUNCED_MAX_AGE_MS = 3 * 60 * 60 * 1000;

/**
 * An ongoing degradation is still closed by "back to normal" after a gap this
 * long (API or station down a few hours): a scene that switched something off
 * gets its event to switch it on again.
 */
const DEGRADATION_MAX_GAP_MS = 24 * 60 * 60 * 1000;

/** From this level on, the air quality is degraded ("moderate", 5). */
export const DEGRADED_FROM = 5;

/** Keys of the scene triggers. */
export const TRIGGER = {
  DEGRADED: 'air_quality_degraded',
  BACK_TO_NORMAL: 'air_quality_back_to_normal',
};

const STORE_VERSION = 1;

export class Hub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {() => object} options.getConfig the current normalized config
   * @param {{ load: Function, save: Function }} options.store
   * @param {typeof fetch} [options.fetch]
   * @param {() => number} [options.now]
   */
  constructor({ gladys, getConfig, store, fetch, now = () => Date.now() }) {
    this.gladys = gladys;
    this.getConfig = getConfig;
    this.store = store;
    this.deps = { fetch };
    this.now = now;
    this.catalog = new Catalog({ deps: this.deps, now });
    /** Record by station id. */
    this.records = new Map();
    /** Set when the device list must be published again (new pollutant, name). */
    this.devicesChanged = false;
    /** Set when the widget content changed. */
    this.widgetChanged = false;
    this.persistNeeded = false;
    /** Scene events waiting for the publication of their station's states. */
    this.pendingEvents = new Map();
    /** Outcome of the last read of each station: { ok, error? }. */
    this.lastResults = new Map();
    this.issues = createIssueLog(logger);
  }

  async load() {
    const data = await this.store.load();
    if (data.version !== STORE_VERSION) {
      return;
    }
    this.catalog.restore(data.catalog);
    for (const record of data.records ?? []) {
      if (record && /^\d+$/.test(String(record.id))) {
        this.records.set(String(record.id), record);
      }
    }
  }

  async persist() {
    await this.store.save({
      version: STORE_VERSION,
      catalog: this.catalog.snapshot(),
      records: [...this.records.values()],
    });
  }

  /** Persist if anything changed since the last save. */
  async save() {
    if (this.persistNeeded || this.catalog.changed) {
      this.persistNeeded = false;
      this.catalog.changed = false;
      await this.persist();
    }
  }

  /** The configured station ids. */
  units(config = this.getConfig()) {
    return config.stationIds;
  }

  /** The records of the configured stations, in the configured order. */
  configuredRecords(config = this.getConfig()) {
    return this.units(config)
      .map((id) => this.records.get(id))
      .filter(Boolean);
  }

  /** The record of a device (or feature) external id, if configured. */
  recordByDevice(externalId) {
    const id = stationIdOf(externalId);
    return id && this.units().includes(id) ? this.records.get(id) : undefined;
  }

  /** True when the user added the station's device to Gladys. */
  isCreated(record) {
    const id = idsOf(this.gladys, record.id).device;
    return (this.gladys.devices ?? []).some((device) => device.external_id === id);
  }

  /** The name the user gave the device in Gladys, else ours. */
  nameOf(record) {
    const id = idsOf(this.gladys, record.id).device;
    return (
      (this.gladys.devices ?? []).find((device) => device.external_id === id)?.name ||
      deviceName(record)
    );
  }

  /** True once the station answered with at least one pollutant. */
  isKnown(record) {
    return Boolean(record?.seriesAt) && (record.pollutants ?? []).length > 0;
  }

  /** The discovery payloads of the configured stations read at least once. */
  buildDevices(config = this.getConfig()) {
    return this.configuredRecords(config)
      .filter((record) => this.isKnown(record))
      .map((record) => buildDevice(this.gladys, record, config.language));
  }

  /** Minutes since the hour of the most recent data, or null. */
  ageMinutes(record) {
    const times = Object.values(record?.values ?? {})
      .map((item) => item?.at)
      .filter((at) => typeof at === 'number');
    if (times.length === 0) {
      return null;
    }
    return Math.max(0, Math.floor((this.now() - Math.max(...times)) / 60_000));
  }

  /** True when the newest data are older than STALE_MINUTES (or absent). */
  isStale(record) {
    const minutes = this.ageMinutes(record);
    return minutes === null || minutes > STALE_MINUTES;
  }

  /** True when a dated value is recent enough to be shown as current. */
  isFresh(at) {
    return typeof at === 'number' && this.now() - at <= STALE_MINUTES * 60_000;
  }

  /**
   * The current BelAQI of a record, from its fresh values: `{ level, key,
   * subIndexes }`, or null (none of its four pollutants is fresh).
   */
  indexOf(record) {
    if (!record) {
      return null;
    }
    const index = computeIndex(this.valuesOf(record));
    return index && { ...index, key: levelKey(index.level) };
  }

  /** The hour of the newest value the index is computed from, or null. */
  indexTime(record) {
    const times = INDEX_POLLUTANTS.map((key) => record.values?.[key]?.at).filter((at) =>
      this.isFresh(at),
    );
    return times.length === 0 ? null : Math.max(...times);
  }

  /** The fresh values of a record, by pollutant. */
  valuesOf(record) {
    const values = {};
    for (const key of pollutantsOf(record)) {
      const item = record.values?.[key];
      if (item && typeof item.value === 'number' && this.isFresh(item.at)) {
        values[key] = item.value;
      }
    }
    return values;
  }

  /**
   * The pollutants that set a degraded index (their sub-index equals it), as
   * formulas; '' while the air is good (every pollutant would qualify).
   */
  criticalPollutants(record) {
    const index = this.indexOf(record);
    if (!index || index.level < DEGRADED_FROM) {
      return '';
    }
    return POLLUTANTS.filter((key) => index.subIndexes[key] === index.level)
      .map((key) => FORMULAS[key])
      .join(', ');
  }

  /**
   * Read one station: its name (station list) and the last value of each
   * pollutant, then the index.
   * @param {string} id
   */
  async refresh(id) {
    const record = this.records.get(id) ?? { id, pollutants: [], values: {} };
    this.records.set(id, record);
    try {
      await this.refreshIdentity(record);
      const before = JSON.stringify({
        level: this.indexOf(record)?.level ?? null,
        values: this.valuesOf(record),
      });
      const series = await fetchSeries(id, this.deps);
      this.applySeries(record, series);
      record.seriesAt = this.now();
      if (record.pollutants.length === 0) {
        // Not in the list: a wrong number. In it: a station of the network
        // that measures none of our pollutants (weather mast, NO only...).
        const unknown = this.catalog.stations.length > 0 && !this.catalog.byId(id);
        throw Object.assign(
          new Error(unknown ? 'unknown to IRCEL-CELINE' : 'measures no pollutant read here'),
          { unknown, empty: !unknown },
        );
      }
      this.applyIndex(record);
      const after = JSON.stringify({
        level: this.indexOf(record)?.level ?? null,
        values: this.valuesOf(record),
      });
      if (before !== after) {
        this.widgetChanged = true;
      }
      this.persistNeeded = true;
      this.lastResults.set(id, { ok: true });
      this.issues.ok(`station:${id}`, `${deviceName(record)}: read again`);
      this.issues.ok('api', 'The IRCEL-CELINE API answers again');
      logger.debug(`${deviceName(record)}: ${JSON.stringify(record.values)}`);
      return record;
    } catch (err) {
      this.lastResults.set(id, {
        ok: false,
        error: err.message,
        unknown: err.unknown === true,
        empty: err.empty === true,
      });
      if (err instanceof ApiError && err.unreachable) {
        // Unreachable: one problem for every station.
        this.issues.fail('api', err.message);
      } else {
        this.issues.fail(`station:${id}`, `${deviceName(record)}: ${err.message}`);
      }
      throw err;
    }
  }

  /** The name and place of a station, from the IRCEL list (read once a day). */
  async refreshIdentity(record) {
    try {
      await this.catalog.ensure();
      this.issues.ok('catalog', 'The IRCEL-CELINE station list is readable again');
    } catch (err) {
      this.issues.fail('catalog', `IRCEL-CELINE station list: ${err.message}`);
    }
    const station = this.catalog.byId(record.id);
    if (station && (station.name !== record.name || station.code !== record.code)) {
      if (record.name === undefined) {
        logger.info(`Station #${record.id} found: ${station.code} ${station.name}`);
      }
      Object.assign(record, {
        name: station.name,
        code: station.code,
        lat: station.lat,
        lon: station.lon,
      });
      this.devicesChanged = true;
    }
  }

  /**
   * The last value of each pollutant. A station may have two series of one
   * pollutant (an instrument replaced): the newest value wins. A value dated
   * in the future (seen once in the API) counts as measured now.
   */
  applySeries(record, series) {
    for (const item of series) {
      if (!item.last || this.now() - item.last.at > ACTIVE_MS) {
        continue;
      }
      this.learn(record, item.pollutant);
      const latest = { value: item.last.value, at: Math.min(item.last.at, this.now()) };
      const previous = record.values[item.pollutant];
      if (!previous || latest.at >= previous.at) {
        record.values[item.pollutant] = latest;
      }
    }
  }

  /** A pollutant the station measures: a feature, forever. */
  learn(record, pollutant) {
    if (!record.pollutants.includes(pollutant)) {
      record.pollutants.push(pollutant);
      this.devicesChanged = true;
    }
  }

  /** A new index (a newer hour): evaluate the scene triggers. */
  applyIndex(record) {
    const index = this.indexOf(record);
    const at = this.indexTime(record);
    // A new hour, or the same hour completed by a late pollutant (or one
    // turning stale) that moves the level.
    if (!index || (at === record.indexAt && index.level === record.announced)) {
      return;
    }
    record.indexAt = at;
    const event = this.levelEvent(record, index.level);
    if (event) {
      this.pendingEvents.set(record.id, event);
    }
  }

  /**
   * The scene event of a new level, if any. `announced` is the last level
   * seen, `worst` the worst level of the ongoing degradation.
   */
  levelEvent(record, level) {
    if (level === null || level === undefined) {
      return null;
    }
    const recent =
      typeof record.announcedAt === 'number' &&
      this.now() - record.announcedAt <= ANNOUNCED_MAX_AGE_MS;
    let previous = recent ? record.announced : null;
    const degradationOpen =
      (record.worst ?? 0) >= DEGRADED_FROM &&
      typeof record.announcedAt === 'number' &&
      this.now() - record.announcedAt <= DEGRADATION_MAX_GAP_MS;
    if (previous === null && degradationOpen && level < DEGRADED_FROM) {
      previous = record.worst;
    }
    record.announced = level;
    record.announcedAt = this.now();
    if (previous === null || previous === undefined) {
      record.worst = level >= DEGRADED_FROM ? level : null;
      return null;
    }
    const language = this.getConfig().language;
    const common = {
      station: idsOf(this.gladys, record.id).device,
      station_name: this.nameOf(record),
      level: levelKey(level),
      level_label: LEVELS[levelKey(level)][language],
      level_index: level,
      previous_level: levelKey(previous),
      previous_level_index: previous,
    };
    if (level >= DEGRADED_FROM && level > previous) {
      record.worst = Math.max(record.worst ?? level, level);
      return {
        key: TRIGGER.DEGRADED,
        data: {
          ...common,
          pollutant: this.criticalPollutants(record),
          summary: this.summary(record, language),
        },
      };
    }
    if (level < DEGRADED_FROM && previous >= DEGRADED_FROM) {
      const worst = Math.max(record.worst ?? previous, previous);
      record.worst = null;
      return {
        key: TRIGGER.BACK_TO_NORMAL,
        data: {
          ...common,
          worst_level: levelKey(worst),
          worst_level_label: LEVELS[levelKey(worst)][language],
          worst_level_index: worst,
          summary: this.summary(record, language),
        },
      };
    }
    if (level >= DEGRADED_FROM) {
      record.worst = Math.max(record.worst ?? level, level);
    }
    return null;
  }

  /** The ready-made sentence of a station, in a language. */
  summary(record, language) {
    return MESSAGES.summary({
      station: this.nameOf(record),
      level: this.indexOf(record)?.key ?? null,
      values: this.valuesOf(record),
    })[language];
  }

  /**
   * Publish the states of a station whose device exists in Gladys: its fresh
   * index and values, and its age. Only the changes go out (the SDK
   * deduplicates), plus a heartbeat.
   * @param {object} record
   * @param {{ force?: boolean }} [options] force: the device was just added
   */
  async publishStates(record, { force = false } = {}) {
    if (!this.isCreated(record)) {
      // No device, no scene can name it: the event is dropped.
      this.pendingEvents.delete(record.id);
      return;
    }
    const ids = idsOf(this.gladys, record.id);
    if (force) {
      this.gladys.forgetPublishedStates(ids.device);
    }
    const language = this.getConfig().language;
    const states = [];
    const state = (key, value) =>
      states.push({
        device_feature_external_id: ids.feature(key),
        ...(typeof value === 'string' ? { text: value } : { state: value }),
      });
    const index = this.indexOf(record);
    if (index) {
      state(INDEX_KEY, index.level);
      state(QUALITY_KEY, LEVELS[index.key][language]);
    }
    for (const [key, value] of Object.entries(this.valuesOf(record))) {
      state(key, value);
    }
    const minutes = this.ageMinutes(record);
    if (minutes !== null) {
      state(AGE_KEY, minutes);
    }
    let failure = null;
    if (states.length > 0) {
      try {
        await this.gladys.publishChangedStates(states, { heartbeat: STATE_HEARTBEAT_MS });
      } catch (err) {
        failure = err;
      }
    }
    // The event goes out even if the states failed, and stays pending until
    // Gladys took it: `announced` already moved, it would never come again.
    const event = this.pendingEvents.get(record.id);
    if (event) {
      await this.gladys.publishSceneEvent(event.key, event.data);
      this.pendingEvents.delete(record.id);
      logger.debug(
        `${deviceName(record)}: air quality ${event.data.previous_level} -> ${event.data.level}`,
      );
    }
    if (failure) {
      throw failure;
    }
  }

  /** Forget the records of the stations no longer configured. */
  prune(config = this.getConfig()) {
    const kept = new Set(this.units(config));
    for (const id of this.records.keys()) {
      if (!kept.has(id)) {
        this.records.delete(id);
        this.persistNeeded = true;
      }
    }
  }
}
