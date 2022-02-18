# signalk-triplogger

This plugin keeps automatic track of the distance traveled on the current trip. The distance tracked is based on vessel GPS positions, so it tracks distance over ground, not distance over water like traditional paddlewheel logs.

The plugin monitors `vessel.state` as set by the [signalk-autostate](https://github.com/meri-imperiumi/signalk-autostate) plugin. Trip recording ends when vessel is detected as anchored or moored, and when vessel again gets under way, the trip log is reset to 0NM.

## Changes

* 1.0.0 (February 18th 2022)
  - Initial version, logging in-memory only
