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

  function prepareLogs() {
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
          logs[logName] = new Logger(getLogPath(logName));
          return logs[logName].exists()
            .then((exists) => {
              if (!exists) {
                // New log, no need to load
                return Promise.resolve();
              }
              return logs[logName].load();
            });
        }
        return Promise.resolve();
      })));
  }

  plugin.start = (options) => {
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
          path: 'navigation.trip.log',
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
          path: 'navigation.log',
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
              path: 'navigation.trip.log',
              value: logs.current.log.total,
            },
          ];
          if (options.totals) {
            const base = options.totals_base || 0;
            values.push({
              path: 'navigation.log',
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
      totals: {
        type: 'boolean',
        default: true,
        title: 'Publish a total number in navigation.log',
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
