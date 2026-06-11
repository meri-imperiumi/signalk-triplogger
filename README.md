# signalk-triplogger

This plugin keeps automatic track of the distance traveled on the current trip. The distance tracked is based on vessel GPS positions, so it tracks distance over ground, not distance over water like traditional paddlewheel logs.

The plugin monitors vessel `navigation.state` as set by the [signalk-autostate](https://github.com/meri-imperiumi/signalk-autostate) plugin. Trip recording ends when vessel is detected as anchored or moored, and when vessel again gets under way, the trip log is reset to 0NM. **Install the autostate plugin or ensure your `navigation.state` is correctly set to use this plugin.**

## Changes

* 1.3.0 (June 10th 2026)
  - Don't start a new trip at startup if there's an ongoing one
* 1.2.0 (April 27th 2023)
  - Added support for populating `navigation.log` for totals
* 1.1.1 (February 28th 2023)
  - Fix issue when `navigation.position` doesn't contain coordinates
* 1.1.0 (March 4th 2022)
  - Persist logs for current day/month/year, also by sailing/motoring
* 1.0.1 (February 18th 2022)
  - Fix issue with reading lat and lon
* 1.0.0 (February 18th 2022)
  - Initial version, logging in-memory only
