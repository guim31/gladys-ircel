# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- IRCEL-CELINE stations, the official Belgian air quality network, read
  through its open API (no account): one device per station with the BelAQI
  index (1 to 10, computed from the hourly means with the official grid), its
  level as a word, the pollutants the station measures (PM2.5, PM10, PM1, NO₂,
  O₃, SO₂, CO, black carbon, benzene) and the age of the data.
- "Find a station" button: the stations by name or code, or the nearest to a
  Gladys house, with their number and distance.
- "Check the stations" button: what each configured station answers now.
- "IRCEL air quality" dashboard widget, scene triggers "air quality degraded"
  and "back to normal", scene action "get the air quality".
- Texts and documentation in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-ircel/commits/main
