// -----------------------------------------------------------------------------
// The BelAQI index, 1 (excellent) to 10 (horrible), computed from the hourly
// means of a station.
//
// IRCEL-CELINE publishes no index per station in its API: the index is
// computed here with the official grid "for current air quality, based on
// hourly average concentrations" of the BelAQI in force since November 2022
// (table 2 of https://www.irceline.be/en/air-quality/measurements/belaqi-2022/info_nov2022).
// Each of PM10, PM2.5, O₃ and NO₂ gets a sub-index; the index is the worst of
// the sub-indexes of the pollutants the station measures.
//
// Bounds are the upper bound of each class, as published: integers for PM10,
// O₃ and NO₂ (a value is rounded to the unit first, "0 – 10" then "11 – 20"),
// one decimal for PM2.5 ("0 – 3.5" then "3.6 – 7.5").
// -----------------------------------------------------------------------------

/** Upper bound of the classes 1 to 9, by pollutant; above the last, 10. */
export const GRID = {
  pm10: { decimals: 0, bounds: [10, 20, 35, 45, 60, 80, 95, 110, 140] },
  pm25: { decimals: 1, bounds: [3.5, 7.5, 10, 15, 20, 35, 50, 60, 75] },
  o3: { decimals: 0, bounds: [30, 65, 75, 90, 110, 150, 180, 210, 240] },
  no2: { decimals: 0, bounds: [10, 15, 20, 30, 40, 45, 50, 60, 75] },
};

/** The pollutants of the index. */
export const INDEX_POLLUTANTS = Object.keys(GRID);

/**
 * The BelAQI sub-index of one hourly mean, 1 to 10, or null.
 * @param {string} pollutant
 * @param {number} value µg/m³
 */
export function subIndex(pollutant, value) {
  const grid = GRID[pollutant];
  if (!grid || typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** grid.decimals;
  // A small negative reading (analyser noise around zero) is class 1.
  const rounded = Math.round(Math.max(0, value) * factor) / factor;
  const position = grid.bounds.findIndex((bound) => rounded <= bound);
  return position === -1 ? 10 : position + 1;
}

/**
 * The index of a set of hourly means: the worst sub-index, and the pollutants
 * that set it. Null when none of the four is given.
 * @param {Record<string, number>} values µg/m³, by pollutant key
 * @returns {{ level: number, subIndexes: Record<string, number> } | null}
 */
export function computeIndex(values) {
  const subIndexes = {};
  for (const key of INDEX_POLLUTANTS) {
    const sub = subIndex(key, values[key]);
    if (sub !== null) {
      subIndexes[key] = sub;
    }
  }
  const levels = Object.values(subIndexes);
  return levels.length === 0 ? null : { level: Math.max(...levels), subIndexes };
}
