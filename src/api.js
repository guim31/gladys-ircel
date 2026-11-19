// -----------------------------------------------------------------------------
// The IRCEL-CELINE open API (https://geo.irceline.be/sos/api/v1/), the
// 52°North "timeseries API" in front of the Belgian measuring network: open,
// without key nor account. This module is the only place that knows its
// shapes, and returns neutral objects to the rest of the code.
//
// Two requests only:
//   /stations                                  every station: id, "code - name", [lon, lat]
//   /timeseries?station=<id>&expanded=true     the series of a station, each with
//                                              its phenomenon, unit and last value
// IRCEL publishes no rate limit: the integration reads one station after the
// other, at most twice an hour, and the station list once a day.
// -----------------------------------------------------------------------------

export const API_URL = 'https://geo.irceline.be/sos/api/v1';

const TIMEOUT_MS = 20_000;

const USER_AGENT = 'gladys-ircel (+https://github.com/guim31/gladys-ircel)';

/** The pollutants the integration publishes, by IRCEL phenomenon id. */
export const POLLUTANT_BY_PHENOMENON = {
  6001: 'pm25',
  5: 'pm10',
  6002: 'pm1',
  8: 'no2',
  7: 'o3',
  1: 'so2',
  10: 'co',
  391: 'bc',
  20: 'c6h6',
};

/** Factor to µg/m³, by unit as IRCEL writes it (CO comes in mg/m³ or µg/m³). */
const TO_MICROGRAMS = { 'µg/m³': 1, 'mg/m³': 1000 };

export class ApiError extends Error {
  /** A server error (5xx): the service is down when every station gets one. */
  get serverError() {
    return this.status >= 500;
  }

  /**
   * @param {string} message
   * @param {{ status?: number, unreachable?: boolean }} [details]
   */
  constructor(message, { status, unreachable = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    /** No answer at all (DNS, network, timeout): one problem for every station. */
    this.unreachable = unreachable;
  }
}

/**
 * GET a path of the API, as JSON.
 * @param {string} path
 * @param {{ fetch?: typeof fetch }} [deps]
 */
async function getJson(path, { fetch: fetchImpl = globalThis.fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(`${API_URL}${path}`, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'timeout' : err.cause?.code || err.message;
    throw new ApiError(`IRCEL API unreachable (${reason})`, { unreachable: true });
  }
  if (!response.ok) {
    throw new ApiError(`IRCEL API: HTTP ${response.status}`, { status: response.status });
  }
  try {
    return await response.json();
  } catch {
    throw new ApiError('IRCEL API: unreadable answer', { status: response.status });
  }
}

const toNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * "40AL01 - Linkeroever" -> { code: "40AL01", name: "Linkeroever" }. A few
 * labels miss a space around the dash ("TOP3M1 -Antwerpen (Neerstraat)",
 * "44EG08- Evergem").
 */
export function splitLabel(label) {
  const text = String(label ?? '').trim();
  const match = /^(\S+?)\s*-\s*(.+)$/.exec(text);
  return match ? { code: match[1], name: match[2].trim() } : { code: '', name: text };
}

/**
 * Every station of the network.
 * @param {{ fetch?: typeof fetch }} [deps]
 * @returns {Promise<Array<{ id: string, code: string, name: string, lat: number|null, lon: number|null }>>}
 */
export async function fetchStations(deps) {
  const body = await getJson('/stations', deps);
  if (!Array.isArray(body)) {
    throw new ApiError('IRCEL API: no station list in the answer');
  }
  const stations = [];
  for (const item of body) {
    const id = toNumber(Number(item?.properties?.id));
    if (id === null) {
      continue;
    }
    const [lon, lat] = item.geometry?.coordinates ?? [];
    stations.push({
      id: String(id),
      ...splitLabel(item.properties.label),
      lat: toNumber(lat),
      lon: toNumber(lon),
    });
  }
  return stations;
}

/**
 * The series of a station for the pollutants we publish, with their last
 * value in µg/m³. A station unknown to IRCEL answers an empty list.
 * @param {string} stationId
 * @param {{ fetch?: typeof fetch }} [deps]
 * @returns {Promise<Array<{ id: string, pollutant: string, last: { value: number, at: number } | null }>>}
 */
export async function fetchSeries(stationId, deps) {
  const body = await getJson(
    `/timeseries?station=${encodeURIComponent(stationId)}&expanded=true`,
    deps,
  );
  if (!Array.isArray(body)) {
    throw new ApiError('IRCEL API: no series list in the answer');
  }
  const series = [];
  for (const item of body) {
    const pollutant = POLLUTANT_BY_PHENOMENON[item?.parameters?.phenomenon?.id];
    const factor = TO_MICROGRAMS[item?.uom];
    if (!pollutant || factor === undefined) {
      continue;
    }
    const value = toNumber(item.lastValue?.value);
    const at = toNumber(item.lastValue?.timestamp);
    series.push({
      id: String(item.id),
      pollutant,
      last: value === null || at === null ? null : { value: round(value * factor), at },
    });
  }
  return series;
}

/** Three decimals at most: mg/m³ to µg/m³ must not add float noise. */
const round = (value) => Math.round(value * 1000) / 1000;
