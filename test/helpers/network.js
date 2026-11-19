// -----------------------------------------------------------------------------
// A simulated IRCEL-CELINE API, answering with the real responses recorded on
// 2026-11-19 around 20:20 UTC (test/fixtures/ircel): Gent (1207, 44R701),
// Brussel Beliardstraat (1711, 41B008, no particulate matter) and Linkeroever
// (1030, 40AL01, particulate matter only). Their last hourly mean is dated
// 19:00 UTC. Tests never touch the real network.
// -----------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';

const url = (name) => new URL(`../fixtures/ircel/${name}.json`, import.meta.url);

/** A recorded answer, parsed (null when there is none). */
export function fixture(name) {
  return existsSync(url(name)) ? JSON.parse(readFileSync(url(name), 'utf8')) : null;
}

/** The stations of the fixtures. */
export const GENT = '1207';
export const BRUSSEL = '1711';
export const LINKEROEVER = '1030';

/** The hour of the last values of the fixtures. */
export const DATA_AT = Date.parse('2026-11-19T19:00:00Z');

/** IRCEL phenomenon ids, by pollutant key. */
const PHENOMENON = { pm25: '6001', pm10: '5', no2: '8', o3: '7', co: '10' };

/**
 * A station's series answer, its values moved some hours later and replaced
 * where given: `seriesAt(GENT, 1, { no2: 80 })`. A value `null` empties it.
 */
export function seriesAt(station, hours, values = {}) {
  const body = fixture(`timeseries-${station}`);
  for (const item of body) {
    if (item.lastValue && item.lastValue.timestamp === DATA_AT) {
      item.lastValue.timestamp += hours * 3_600_000;
    }
    for (const [key, value] of Object.entries(values)) {
      if (item.parameters.phenomenon.id === PHENOMENON[key]) {
        item.lastValue.value = value;
      }
    }
  }
  return body;
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now] the clock passed to the route functions
 */
export function createNetwork({ now = () => Date.now() } = {}) {
  const calls = [];
  const network = {
    calls,
    /** Overrides by station id: a body, a function (now) => body, an Error, or { status }. */
    series: {},
    stations: null,
    /** The whole API unreachable. */
    down: false,
    fetch,
  };

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  function answer(route, fallback) {
    const value = typeof route === 'function' ? route(now()) : route;
    if (value instanceof Error) {
      throw value;
    }
    if (value && !Array.isArray(value) && typeof value === 'object' && value.status) {
      return new Response('<html>error</html>', { status: value.status });
    }
    return json(value ?? fallback);
  }

  async function fetch(href) {
    const path = String(href).replace('https://geo.irceline.be/sos/api/v1', '');
    calls.push(path);
    if (network.down) {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }
    let match;
    if (path === '/stations') {
      return answer(network.stations, fixture('stations'));
    }
    if ((match = /^\/timeseries\?station=(\d+)&expanded=true$/.exec(path))) {
      // A station unknown to IRCEL answers an empty list.
      return answer(network.series[match[1]], fixture(`timeseries-${match[1]}`) ?? []);
    }
    return new Response('not found', { status: 404 });
  }

  return network;
}
