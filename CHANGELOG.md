# Changelog

## [Unreleased]

### Added
- Option to publish the current trip log (`log_path`) and the total log
  (`totals_path`) under configurable Signal K paths, for setups where the
  standard `navigation.trip.log`/`navigation.log` paths are owned by another
  provider. Non-standard paths are announced with `units: m` metadata

### Fixed
- Don't overwrite the current trip log at startup: log preparation is now
  serialized so distance appends and state handling always run against the
  persisted log once it has finished loading from disk

## [1.3.2] - 2026-08-23

### Added
- Added smoke tests for the plugin entry point (start/stop, subscription,
  state-change resets, position logging, totals)

## [1.3.1] - 2026-06-16

### Added
- Added application icon for SK appstore

## [1.3.0] - 2026-06-10

### Fixed
- Don't start a new trip at startup if there's an ongoing one

## [1.2.0] - 2023-04-27

### Added
- Added support for populating `navigation.log` for totals

## [1.1.1] - 2023-02-28

### Fixed
- Fix issue when `navigation.position` doesn't contain coordinates

## [1.1.0] - 2022-03-04

### Added
- Persist logs for current day/month/year, also by sailing/motoring

## [1.0.1] - 2022-02-18

### Fixed
- Fix issue with reading lat and lon

## [1.0.0] - 2022-02-18

### Added
- Initial version, logging in-memory only
