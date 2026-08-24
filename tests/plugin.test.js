/**
 * Smoke tests for the plugin entry point (plugin shape, start/stop,
 * subscription, state-change resets, position logging, totals).
 * @file plugin.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const makePlugin = require('../index');
const { FakeSignalKApp, emitDelta } = require('./fake-app');

/**
 * Wait `ms` milliseconds, resolving the returned promise.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise((r) => { setTimeout(r, ms); });
}

/**
 * Poll until `predicate` returns truthy, retrying every ~10ms up to `timeout`
 * milliseconds. Resolves true on success, false on timeout. Useful for
 * awaiting async plugin side-effects (file I/O) without fixed sleeps.
 *
 * @param {() => boolean} predicate
 * @param {number} [timeout]
 * @returns {Promise<boolean>}
 */
function waitFor(predicate, timeout = 500) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeout) {
        resolve(false);
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

/**
 * Build a started plugin instance wired to a fresh fake app with the
 * given settings (defaulted).
 *
 * @param {object} [overrides]
 * @returns {{app: FakeSignalKApp, plugin: object}}
 */
function makeStarted(overrides) {
  const app = new FakeSignalKApp();
  const plugin = makePlugin(app);
  plugin.start({
    update_interval: 10000,
    totals: true,
    totals_base: 0,
    ...overrides,
  });
  return { app, plugin };
}

/**
 * Read a log file written by the Logger from the app's data dir.
 *
 * @param {FakeSignalKApp} app
 * @param {string} name
 * @returns {object}
 */
function readLog(app, name) {
  return JSON.parse(readFileSync(join(app.dataPath, `${name}.json`), 'utf-8'));
}

test('creates a plugin object with the right id/name', () => {
  const app = new FakeSignalKApp();
  const plugin = makePlugin(app);
  assert.strictEqual(plugin.id, 'signalk-triplogger');
  assert.strictEqual(plugin.name, 'Trip logger');
  assert.ok(plugin.description);
});

test('schema is a JSON object with the expected options', () => {
  const app = new FakeSignalKApp();
  const plugin = makePlugin(app);
  assert.strictEqual(plugin.schema.type, 'object');
  assert.ok(plugin.schema.properties.update_interval);
  assert.ok(plugin.schema.properties.totals);
  assert.ok(plugin.schema.properties.totals_base);
});

test('start subscribes to navigation.state and navigation.position', () => {
  const { app, plugin } = makeStarted();
  assert.strictEqual(app.subscriptionmanager.subscriptions.length, 1);
  const sub = app.subscriptionmanager.subscriptions[0].subscription;
  assert.strictEqual(sub.context, 'vessels.self');
  const paths = sub.subscribe.map((s) => s.path);
  assert.ok(paths.includes('navigation.state'));
  assert.ok(paths.includes('navigation.position'));
  plugin.stop();
});

test('start sets an initial status message', () => {
  const { app, plugin } = makeStarted();
  assert.ok(
    app.statusMessages.some(
      (m) => m.type === 'status' && /waiting/i.test(m.msg),
    ),
    `got ${JSON.stringify(app.statusMessages)}`,
  );
  plugin.stop();
});

test('transitioning into a trip resets the log and posts a status', async () => {
  const { app, plugin } = makeStarted();
  // A fresh current log is considered already in-trip, so first put the
  // vessel into a non-trip state, then transition into a trip state.
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.state', value: 'anchored' }] },
    ],
  });
  await wait(5);
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.state', value: 'sailing' }] },
    ],
  });
  await waitFor(
    () => app.statusMessages.some((m) => /new trip/i.test(m.msg)),
  );
  plugin.stop();
  assert.ok(
    app.statusMessages.some(
      (m) => m.type === 'status' && /new trip/i.test(m.msg),
    ),
    `got ${JSON.stringify(app.statusMessages)}`,
  );
});

test('position updates append distance to the trip log and emit deltas', async () => {
  const { app, plugin } = makeStarted({ totals: true });
  // First establish a non-trip state so a fresh log isn't considered
  // already in-trip, then transition into a trip state and move.
  emitDelta(app, {
    context: 'vessels.self',
    updates: [{ values: [{ path: 'navigation.state', value: 'anchored' }] }],
  });
  await wait(5);
  emitDelta(app, {
    context: 'vessels.self',
    updates: [{ values: [{ path: 'navigation.state', value: 'sailing' }] }],
  });
  await wait(5);

  // First position just establishes lastPosition; no distance yet.
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.0, longitude: 24.0 } }] },
    ],
  });
  await wait(5);

  // Second position ~111m east of the first → appendTrip writes log files.
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.001, longitude: 24.0 } }] },
    ],
  });
  await waitFor(() => {
    const tripValue = app.messages
      .flatMap(({ message }) => message.updates.flatMap((u) => u.values))
      .find((v) => v.path === 'navigation.trip.log' && v.value > 0);
    return !!tripValue;
  });

  plugin.stop();

  // A trip.log delta should have been published to the app.
  const tripMsgs = app.messages.filter(
    ({ message }) => message.updates.some((u) => u.values.some((v) => v.path === 'navigation.trip.log')),
  );
  assert.ok(tripMsgs.length > 0, 'no navigation.trip.log delta was emitted');

  // The current trip log file should be persisted with a positive total.
  const current = readLog(app, 'current');
  assert.ok(current.total > 0, `current.total was ${current.total}`);
});

test('totals option also publishes navigation.log', async () => {
  const { app, plugin } = makeStarted({ totals: true, totals_base: 100 });
  emitDelta(app, {
    context: 'vessels.self',
    updates: [{ values: [{ path: 'navigation.state', value: 'anchored' }] }],
  });
  await wait(5);
  emitDelta(app, {
    context: 'vessels.self',
    updates: [{ values: [{ path: 'navigation.state', value: 'motoring' }] }],
  });
  await wait(5);

  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.0, longitude: 24.0 } }] },
    ],
  });
  await wait(5);
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.002, longitude: 24.0 } }] },
    ],
  });
  await waitFor(() => {
    const logValue = app.messages
      .flatMap(({ message }) => message.updates.flatMap((u) => u.values))
      .find((v) => v.path === 'navigation.log' && v.value > 100);
    return !!logValue;
  });
  plugin.stop();

  const logMsgs = app.messages.filter(
    ({ message }) => message.updates.some((u) => u.values.some((v) => v.path === 'navigation.log')),
  );
  assert.ok(logMsgs.length > 0, 'no navigation.log delta was emitted');
  const last = logMsgs[logMsgs.length - 1];
  const { value } = last.message.updates
    .flatMap((u) => u.values)
    .find((v) => v.path === 'navigation.log');
  // totals_base of 100 should be added on top of the logged distance.
  assert.ok(value > 100, `navigation.log value was ${value}`);
});

test('stop clears subscriptions', () => {
  const { app, plugin } = makeStarted();
  assert.strictEqual(app.subscriptionmanager.subscriptions.length, 1);
  plugin.stop();
  assert.strictEqual(app.subscriptionmanager.subscriptions.length, 0);
});
