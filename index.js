const { Point } = require('where');
const { join } = require('path');
const Logger = require('./Logger');

module.exports = (app) => {
  const plugin = {};
  let unsubscribes = [];
  let lastPosition = null;
  const logs = {};

  plugin.id = 'signalk-triplogger';
  plugin.name = 'Trip logger';
  plugin.description = 'Log the length of the current trip';
  const setStatus = app.setPluginStatus || app.setProviderStatus;
  function getLogNames() {
    const dateString = new Date().toISOString();
    return [
      'current', // Current trip
      'total', // Total log
      dateString.substr(0, 4), // Annual log
      dateString.substr(0, 7), // Monthly log
      dateString.substr(0, 10), // Daily log
    ];
  }

  function getLogPath(logName) {
    return join(app.getDataDirPath(), `${logName}.json`);
  }

  let logsPrepared = Promise.resolve();

  function prepareLogs() {
    // Serialize preparations: a Logger instance is created synchronously,
    // but only loaded from disk asynchronously. Without serialization a
    // second call (for example, a position delta right after a state
    // delta at startup) would see the instance already in `logs` and
    // proceed before `load()` has finished, appending to and saving a
    // fresh zeroed log over the persisted one.
    const preparation = logsPrepared.then(() => {
      const newLogs = getLogNames();
      return Promise.all(Object.keys(logs).map((logName) => {
        // Close old logs
        if (newLogs.indexOf(logName) === -1) {
          // If log is not in the new log list, end it
          const oldLog = logs[logName];
          delete logs[logName];
          return oldLog.endTrip();
        }
        return Promise.resolve();
      }))
        .then(() => Promise.all(newLogs.map((logName) => {
          // Load new logs
          if (!logs[logName]) {
            // New log, or saved log?
            const log = new Logger(
              getLogPath(logName),
              (message) => app.error(message),
            );
            logs[logName] = log;
            return log.exists()
              .then((exists) => {
                if (!exists) {
                  // New log, no need to load
                  return Promise.resolve();
                }
                return log.load();
              });
          }
          return Promise.resolve();
        })));
    });
    // Keep the chain usable even if a single preparation fails
    logsPrepared = preparation.catch(() => {});
    return preparation;
  }

  plugin.start = (options) => {
    // Paths the logs are published under. Configure these when another
    // provider owns the standard paths, for example when a club's total
    // log is maintained elsewhere for their maintenance schedule.
    const tripLogPath = options.log_path || 'navigation.trip.log';
    const totalLogPath = options.totals_path || 'navigation.log';
    const subscription = {
      context: 'vessels.self',
      subscribe: [
        {
          path: 'navigation.state',
          period: 1000,
        },
        {
          path: 'navigation.position',
          period: options.update_interval || 10000,
        },
      ],
    };

    function resetTrip() {
      logs.current.reset();
      const resetTime = logs.current.log.started;
      const values = [
        {
          path: tripLogPath,
          value: logs.current.log.total,
        },
        {
          path: 'navigation.trip.lastReset',
          value: resetTime,
        },
      ];
      if (options.totals) {
        const base = options.totals_base || 0;
        values.push({
          path: totalLogPath,
          value: logs.total.log.total + base,
        });
      }

      app.handleMessage(plugin.id, {
        context: `vessels.${app.selfId}`,
        updates: [
          {
            source: {
              label: plugin.id,
            },
            timestamp: (new Date().toISOString()),
            values,
          },
        ],
      });
    }

    function appendTrip(distance) {
      prepareLogs()
        .then(() => Promise.all(Object.keys(logs).map((logName) => {
          // Append distance to all active logs and save
          logs[logName].appendTrip(distance);
          // TODO: We may want to throttle saves to be less frequent
          return logs[logName].save();
        })))
        .then(() => {
          const values = [
            {
              path: tripLogPath,
              value: logs.current.log.total,
            },
          ];
          if (options.totals) {
            const base = options.totals_base || 0;
            values.push({
              path: totalLogPath,
              value: logs.total.log.total + base,
            });
          }
          app.handleMessage(plugin.id, {
            context: `vessels.${app.selfId}`,
            updates: [
              {
                source: {
                  label: plugin.id,
                },
                timestamp: (new Date().toISOString()),
                values,
              },
            ],
          });
        })
        .catch((err) => {
          app.error(`Error:${err}`);
        });
    }

    function handleState(state) {
      prepareLogs()
        .then(() => {
          const wasInTrip = logs.current.inTrip();
          Object.keys(logs).forEach((logName) => {
            // Allow loggers to keep track of distance per state
            logs[logName].setState(state);
          });
          const isInTrip = logs.current.inTrip();
          if (isInTrip && !wasInTrip) {
            // New trip has started
            resetTrip();
            setStatus('New trip has started. Log reset');
          }
        })
        .catch((err) => {
          app.error(`Error:${err}`);
        });
    }

    function sendMeta() {
      // Non-standard paths are not in the Signal K schema, so consumers
      // cannot know their units. Tell the server they are meters.
      const meta = [];
      if (tripLogPath !== 'navigation.trip.log') {
        meta.push({
          path: tripLogPath,
          value: {
            units: 'm',
            displayName: 'Current trip log',
            description: 'Distance travelled during the current trip',
          },
        });
      }
      if (options.totals && totalLogPath !== 'navigation.log') {
        meta.push({
          path: totalLogPath,
          value: {
            units: 'm',
            displayName: 'Total log',
            description: 'Total distance travelled',
          },
        });
      }
      if (meta.length === 0) {
        return;
      }
      app.handleMessage(plugin.id, {
        context: `vessels.${app.selfId}`,
        updates: [
          {
            source: {
              label: plugin.id,
            },
            timestamp: (new Date().toISOString()),
            meta,
          },
        ],
      });
    }

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (subscriptionError) => {
        app.error(`Error:${subscriptionError}`);
      },
      (delta) => {
        if (!delta.updates) {
          return;
        }
        delta.updates.forEach((u) => {
          if (!u.values) {
            return;
          }
          u.values.forEach((v) => {
            if (v.path === 'navigation.state') {
              // Potential state change
              handleState(v.value);
            }
            if (v.path === 'navigation.position') {
              if (!v.path || Number.isNaN(Number(v.value.latitude))
                || Number.isNaN(Number(v.value.longitude))) {
                return;
              }
              const newPosition = new Point(v.value.latitude, v.value.longitude);
              if (lastPosition) {
                const distance = lastPosition.distanceTo(newPosition) * 1000;
                appendTrip(distance);
              }
              lastPosition = newPosition;
              if (logs.current) {
                if (logs.current.inTrip()) {
                  setStatus(`Under way: ${logs.current}`);
                } else {
                  setStatus(`Stopped. Last trip: ${logs.current}`);
                }
              }
            }
          });
        });
      },
    );

    // Load persisted logs eagerly so that a trip ongoing from a previous
    // session is continued when deltas arrive, instead of being reset
    prepareLogs().catch((err) => {
      app.error(`Error:${err}`);
    });

    // Declare units for any non-standard paths we publish to
    sendMeta();

    setStatus('Waiting for updates');
  };

  plugin.stop = () => {
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
  };

  plugin.schema = {
    type: 'object',
    properties: {
      update_interval: {
        type: 'number',
        default: 10000,
        title: 'How often to update log, in milliseconds',
      },
      log_path: {
        type: 'string',
        default: 'navigation.trip.log',
        title: 'Signal K path to publish the current trip log to',
      },
      totals: {
        type: 'boolean',
        default: true,
        title: 'Publish a total number in the total log path',
      },
      totals_path: {
        type: 'string',
        default: 'navigation.log',
        title: 'Signal K path to publish the total log to',
      },
      totals_base: {
        type: 'number',
        default: 0,
        title: 'Add this number to the totals (in meters)',
      },
    },
  };

  return plugin;
};
