# IRCEL-CELINE for Gladys Assistant

External integration for [Gladys Assistant](https://gladysassistant.com) that
brings the air quality measured by the official Belgian stations of
[IRCEL-CELINE](https://www.irceline.be), the Belgian Interregional
Environment Agency, into Gladys: the BelAQI index and the pollutants, station
by station, hour by hour.

This integration is **not affiliated with IRCEL-CELINE**.

Looking for something else? A model-based air quality anywhere in the world:
[`prohand/gladys-airquality`](https://github.com/prohand/gladys-airquality)
(Copernicus CAMS). The Belgian weather: [`gboulvin/Gladys-IRM-KMI-V2`](https://github.com/gboulvin/Gladys-IRM-KMI-V2).
The French Atmo indexes: [`William-De71/gladys-atmo-france`](https://github.com/William-De71/gladys-atmo-france).
Here: the measurements of the official Belgian stations.

## What it does

- **Stations** of the IRCEL-CELINE network by their number, through the open
  API (`geo.irceline.be`): no account, no key. A **Find a station** button
  searches the station list by name or code (accents optional), or lists the
  nearest stations to the location of a Gladys house, with their distance.
- **One device per station**: the BelAQI index (1 excellent to 10 horrible)
  and its level as a word, the pollutants the station measures (PM2.5, PM10,
  PM1, NO₂, O₃, SO₂, CO, black carbon, benzene, in µg/m³) and the age of the
  data. Values older than 3 hours are not published as current.
- The **BelAQI** is computed by the integration from the hourly means of PM10,
  PM2.5, O₃ and NO₂ with the official hourly grid of the
  [BelAQI of November 2022](https://www.irceline.be/en/air-quality/measurements/belaqi-2022/info_nov2022):
  IRCEL-CELINE's API publishes no index per station.
- An **IRCEL air quality** dashboard widget (level colored, pollutant tiles),
  two scene triggers, **air quality degraded** (the index rises to "moderate"
  or worse, the levels picked as filters) and **back to normal**, and a scene
  action **Get the air quality** (one station or the worst one, with a
  sentence ready for a notification).

Read only. Tested against the real API (Gent, Brussel Beliardstraat,
Linkeroever): the test fixtures are its recorded answers.

The user documentation, in [English](docs/en.md), [French](docs/fr.md),
[German](docs/de.md) and [Spanish](docs/es.md), is re-hosted by Gladys behind
the **Documentation** link of the Configuration screen.

## Requirements

- Gladys Assistant **5.3.0** or later (the store shows the integration to
  users in Belgium, a 5.3 field; the station search uses the house picker of
  5.2.0, the widget and the scene cards need 5.1).
- Internet access to `geo.irceline.be`.

## Installation

In Gladys, open **Integrations → Install from GitHub** and enter
`https://github.com/guim31/gladys-ircel`. Then fill the Configuration tab: see
[the documentation](docs/en.md#configuration).

## Respect of the API

IRCEL-CELINE publishes no request limit. The integration:

- reads a station every 30 minutes (or every hour), 10 stations at most, one
  after the other, **one request per station**
  (`/timeseries?station=<id>&expanded=true` gives the last value of every
  series);
- reads the station list once a day at most, and keeps it under `/data`;
- reads only the stations whose device was added to Gladys (and, once, the
  ones it does not know yet, to list them in the Discovery tab);
- sends a `User-Agent` naming the integration and this repository.

## Limits

- Hourly means, published about an hour after each hour: the values lag by 1
  to 2 hours, and the regions may still correct them later.
- The index is computed here, from the station's own pollutants: a station
  measuring NO₂ only gets an NO₂-only index, and the value may differ from the
  interpolated map of irceline.be.
- Gladys has no µg/m³ category for PM1, black carbon, CO and benzene: they are
  published as `unknown` features with their unit, named by their formula.
- NO, NH₃, the weather series and the industrial VOCs are left out. A series
  stopped for more than 30 days does not become a feature.

## Development

```bash
npm install
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # node --test, against the SDK's fake Gladys
```

The tests never touch the network: they run on the answers of the
IRCEL-CELINE API recorded on 19 November 2026 (`test/fixtures/ircel`). The
architecture and the rules of the project are in [`CLAUDE.md`](CLAUDE.md).

## Credits

- [IRCEL-CELINE](https://www.irceline.be) and the three Belgian regions for the
  measuring network, the BelAQI index and the open API. The data are
  published under the [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
  license ([open data](https://www.irceline.be/en/documentation/open-data)),
  and used as published; the widget and the documentation name the source.
- The logo on the cover is the IRCEL-CELINE logo, with the colors of the
  BelAQI scale, from [irceline.be](https://www.irceline.be); it only names the
  data source.
- Built from the official
  [JavaScript template](https://github.com/GladysAssistant/integration-template-js)
  and SDK [`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

## License

[Apache-2.0](LICENSE)
