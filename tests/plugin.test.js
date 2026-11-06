/**
 * Smoke tests for the plugin entry point (plugin shape, start/stop,
 * subscription, state-change resets, position logging, totals).
 * @file plugin.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const makePlugin = require('../index');
const { FakeSignalKApp, emitDelta } = require('./fake-app');

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

/**
 * Poll until the persisted current log's total reaches `min` meters.
 * Checks the file rather than emitted deltas: a delta carries the
 * in-memory total, which can already reflect a later appendTrip while
 * that append's racing save has not been renamed into place yet.
 *
 * @param {FakeSignalKApp} app
 * @param {number} min
 * @returns {Promise<boolean>}
 */
function waitForLogTotal(app, min) {
  return waitFor(() => {
    try {
      return readLog(app, 'current').total >= min;
    } catch (err) {
      // Log file not written yet
      return false;
    }
  });
}

/**
 * Pre-seed a log file in the app's data dir before start, so the Logger
 * loads an existing state instead of starting fresh. Used to make the
 * "new trip" transition deterministic without racing two state emits.
 *
 * @param {FakeSignalKApp} app
 * @param {string} name
 * @param {object} contents
 * @returns {void}
 */
function seedLog(app, name, contents) {
  writeFileSync(join(app.dataPath, `${name}.json`), JSON.stringify(contents, null, 2));
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
  const app = new FakeSignalKApp();
  // A fresh current log is considered already in-trip. To make the
  // transition into a trip deterministic (instead of racing two async
  // state emits), seed an *ended* current log so inTrip() starts false,
  // then emit a single trip-starting state.
  seedLog(app, 'current', {
    started: '2026-01-01T00:00:00.000Z',
    ended: '2026-01-01T01:00:00.000Z',
    total: 0,
    states: {},
  });
  const plugin = makePlugin(app);
  plugin.start({});
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
  const app = new FakeSignalKApp();
  // Seed an ended current log so start isn't considered in-trip, then emit
  // a single trip-starting state. This avoids racing two async state emits.
  seedLog(app, 'current', {
    started: '2026-01-01T00:00:00.000Z',
    ended: '2026-01-01T01:00:00.000Z',
    total: 0,
    states: {},
  });
  const plugin = makePlugin(app);
  plugin.start({ totals: true });
  emitDelta(app, {
    context: 'vessels.self',
    updates: [{ values: [{ path: 'navigation.state', value: 'sailing' }] }],
  });
  // Wait for the new-trip reset to settle before sending positions.
  await waitFor(
    () => app.statusMessages.some((m) => /new trip/i.test(m.msg)),
  );

  // First position just establishes lastPosition; no distance yet.
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.0, longitude: 24.0 } }] },
    ],
  });

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
  const app = new FakeSignalKApp();
  seedLog(app, 'current', {
    started: '2026-01-01T00:00:00.000Z',
    ended: '2026-01-01T01:00:00.000Z',
    total: 0,
    states: {},
  });
  const plugin = makePlugin(app);
  plugin.start({ totals: true, totals_base: 100 });
  emitDelta(app, {
    context: 'vessels.self',
    updates: [{ values: [{ path: 'navigation.state', value: 'motoring' }] }],
  });
  await waitFor(
    () => app.statusMessages.some((m) => /new trip/i.test(m.msg)),
  );

  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.0, longitude: 24.0 } }] },
    ],
  });
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

test('startup with an ongoing trip continues it instead of resetting to zero', async () => {
  const app = new FakeSignalKApp();
  // An ongoing trip from a previous session: started, never ended.
  seedLog(app, 'current', {
    started: '2026-01-01T00:00:00.000Z',
    ended: null,
    total: 5000,
    states: { sailing: 5000 },
  });
  const plugin = makePlugin(app);
  plugin.start({ totals: false });

  // Emit state and positions back-to-back, in the same tick, so they
  // race against the async log loading from disk. This used to overwrite
  // current.json with a fresh zeroed log before the saved one was loaded.
  emitDelta(app, {
    context: 'vessels.self',
    updates: [{ values: [{ path: 'navigation.state', value: 'sailing' }] }],
  });
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.0, longitude: 24.0 } }] },
    ],
  });
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.001, longitude: 24.0 } }] },
    ],
  });
  await waitFor(() => app.messages
    .flatMap(({ message }) => message.updates.flatMap((u) => u.values))
    .some((v) => v.path === 'navigation.trip.log'));
  plugin.stop();

  // The persisted trip must survive startup: no reset to zero, and the
  // newly logged distance accumulates on top of the existing total.
  const current = readLog(app, 'current');
  assert.ok(
    current.total >= 5000,
    `current.total was ${current.total}, expected the ongoing trip to continue`,
  );
  assert.ok(
    !app.statusMessages.some((m) => /new trip/i.test(m.msg)),
    `unexpected new-trip reset at startup: ${JSON.stringify(app.statusMessages)}`,
  );

  // The published trip log should also continue from the persisted total.
  const tripValues = app.messages
    .flatMap(({ message }) => message.updates.flatMap((u) => u.values))
    .filter((v) => v.path === 'navigation.trip.log');
  assert.ok(tripValues.length > 0, 'no navigation.trip.log delta was emitted');
  assert.ok(
    tripValues[tripValues.length - 1].value >= 5000,
    `last trip.log value was ${tripValues[tripValues.length - 1].value}`,
  );
});

/**
 * Flatten all value objects the app has received from the plugin.
 * Meta-only messages have no `values`, so those updates are skipped.
 *
 * @param {FakeSignalKApp} app
 * @returns {Array<{path: string, value: number}>}
 */
function emittedValues(app) {
  return app.messages.flatMap(
    ({ message }) => message.updates.filter((u) => u.values).flatMap((u) => u.values),
  );
}

/**
 * Flatten all meta entries the app has received from the plugin.
 *
 * @param {FakeSignalKApp} app
 * @returns {Array<{path: string, value: object}>}
 */
function emittedMeta(app) {
  return app.messages.flatMap(
    ({ message }) => message.updates.filter((u) => u.meta).flatMap((u) => u.meta),
  );
}

test('custom log_path publishes the trip log under the configured path', async () => {
  const app = new FakeSignalKApp();
  seedLog(app, 'current', {
    started: '2026-01-01T00:00:00.000Z',
    ended: '2026-01-01T01:00:00.000Z',
    total: 0,
    states: {},
  });
  const plugin = makePlugin(app);
  plugin.start({
    log_path: 'navigation.trip.currentTripLog',
    totals: false,
  });
  emitDelta(app, {
    context: 'vessels.self',
    updates: [{ values: [{ path: 'navigation.state', value: 'sailing' }] }],
  });
  await waitFor(
    () => app.statusMessages.some((m) => /new trip/i.test(m.msg)),
  );
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.0, longitude: 24.0 } }] },
    ],
  });
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.001, longitude: 24.0 } }] },
    ],
  });
  await waitFor(
    () => emittedValues(app).some(
      (v) => v.path === 'navigation.trip.currentTripLog' && v.value > 0,
    ),
  );
  plugin.stop();

  // The trip log is published under the configured custom path...
  assert.ok(
    emittedValues(app).some((v) => v.path === 'navigation.trip.currentTripLog'),
    'no delta was emitted to navigation.trip.currentTripLog',
  );
  // ...and not under the standard path
  assert.ok(
    !emittedValues(app).some((v) => v.path === 'navigation.trip.log'),
    'navigation.trip.log should not be written when log_path is set',
  );
  // The non-standard path is announced with units metadata
  const tripMeta = emittedMeta(app).find((m) => m.path === 'navigation.trip.currentTripLog');
  assert.ok(tripMeta, 'no meta was sent for the custom trip log path');
  assert.strictEqual(tripMeta.value.units, 'm');
});

test('custom totals_path publishes the total under the configured path', async () => {
  const app = new FakeSignalKApp();
  seedLog(app, 'current', {
    started: '2026-01-01T00:00:00.000Z',
    ended: '2026-01-01T01:00:00.000Z',
    total: 0,
    states: {},
  });
  const plugin = makePlugin(app);
  plugin.start({
    totals: true,
    totals_base: 100,
    totals_path: 'navigation.log.clubTotal',
  });
  emitDelta(app, {
    context: 'vessels.self',
    updates: [{ values: [{ path: 'navigation.state', value: 'motoring' }] }],
  });
  await waitFor(
    () => app.statusMessages.some((m) => /new trip/i.test(m.msg)),
  );
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.0, longitude: 24.0 } }] },
    ],
  });
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.002, longitude: 24.0 } }] },
    ],
  });
  await waitFor(
    () => emittedValues(app).some(
      (v) => v.path === 'navigation.log.clubTotal' && v.value > 100,
    ),
  );
  plugin.stop();

  // The total is published under the configured custom path...
  assert.ok(
    emittedValues(app).some((v) => v.path === 'navigation.log.clubTotal'),
    'no delta was emitted to navigation.log.clubTotal',
  );
  // ...and not under the standard path
  assert.ok(
    !emittedValues(app).some((v) => v.path === 'navigation.log'),
    'navigation.log should not be written when totals_path is set',
  );
  // The trip log keeps its standard path unless configured otherwise
  assert.ok(
    emittedValues(app).some((v) => v.path === 'navigation.trip.log'),
    'navigation.trip.log should still be emitted with only totals_path set',
  );
  // The non-standard path is announced with units metadata
  const totalMeta = emittedMeta(app).find((m) => m.path === 'navigation.log.clubTotal');
  assert.ok(totalMeta, 'no meta was sent for the custom totals path');
  assert.strictEqual(totalMeta.value.units, 'm');
  // No meta is needed for the standard trip path
  assert.ok(
    !emittedMeta(app).some((m) => m.path === 'navigation.trip.log'),
    'standard paths should not get meta',
  );
});

test('standard paths send no meta messages', () => {
  const { app, plugin } = makeStarted();
  assert.strictEqual(emittedMeta(app).length, 0);
  plugin.stop();
});

test('a corrupt persisted log is backed up and logging continues', async () => {
  const app = new FakeSignalKApp();
  // A log truncated by a crash mid-write. With the old code this threw
  // an uncaught exception from the readFile callback, killing the whole
  // server process on every startup.
  const corrupt = '{"started": "2026-09-11T00:00:00.000Z", "total": 5000';
  writeFileSync(join(app.dataPath, 'current.json'), corrupt, 'utf-8');
  const plugin = makePlugin(app);
  plugin.start({ totals: false });

  emitDelta(app, {
    context: 'vessels.self',
    updates: [{ values: [{ path: 'navigation.state', value: 'sailing' }] }],
  });
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.0, longitude: 24.0 } }] },
    ],
  });
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.001, longitude: 24.0 } }] },
    ],
  });
  await waitFor(() => app.messages
    .flatMap(({ message }) => message.updates.flatMap((u) => u.values))
    .some((v) => v.path === 'navigation.trip.log' && v.value > 0));
  plugin.stop();

  // The corrupt contents are preserved for manual recovery...
  assert.strictEqual(
    readFileSync(join(app.dataPath, 'current.json.corrupt'), 'utf-8'),
    corrupt,
  );
  // ...and the corruption was reported
  assert.ok(
    app.errors.some((e) => /corrupt/i.test(e)),
    `got ${JSON.stringify(app.errors)}`,
  );
  // Logging continues from a fresh log
  const current = readLog(app, 'current');
  assert.ok(current.total > 0, `current.total was ${current.total}`);
});

test('stop clears subscriptions', () => {
  const { app, plugin } = makeStarted();
  assert.strictEqual(app.subscriptionmanager.subscriptions.length, 1);
  plugin.stop();
  assert.strictEqual(app.subscriptionmanager.subscriptions.length, 0);
});

test('a trip crossing the antimeridian accumulates the short-way distance', async () => {
  // A boat drifting a few meters east across 180° longitude: the next
  // fix reads as -179.9999 (GPS wraps to [-180, 180]). The distance
  // between the fixes is ~22 m at the equator, not the ~20 000 km the
  // naive longitude difference suggests — the trip total must stay small.
  const app = new FakeSignalKApp();
  seedLog(app, 'current', {
    started: '2026-01-01T00:00:00.000Z',
    ended: '2026-01-01T01:00:00.000Z',
    total: 0,
    states: {},
  });
  const plugin = makePlugin(app);
  plugin.start({ totals: true });
  emitDelta(app, {
    context: 'vessels.self',
    updates: [{ values: [{ path: 'navigation.state', value: 'sailing' }] }],
  });
  await waitFor(() => app.statusMessages.some((m) => /new trip/i.test(m.msg)));

  // First fix just east of the seam.
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: -14.2, longitude: 179.9999 } }] },
    ],
  });
  // Second fix just west of the seam (wrapped) — ~22 m further east.
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: -14.2, longitude: -179.9999 } }] },
    ],
  });
  await waitFor(() => {
    const tripValue = app.messages
      .flatMap(({ message }) => message.updates.flatMap((u) => u.values))
      .find((v) => v.path === 'navigation.trip.log' && v.value > 0);
    return !!tripValue;
  });
  plugin.stop();

  const current = readLog(app, 'current');
  assert.ok(
    current.total > 0 && current.total < 1000,
    `seam crossing logged ${current.total} m; expected the short way (~22 m)`,
  );
});

test('null position values are ignored without crashing or logging Null Island', async () => {
  const app = new FakeSignalKApp();
  seedLog(app, 'current', {
    started: '2026-01-01T00:00:00.000Z',
    ended: '2026-01-01T01:00:00.000Z',
    total: 0,
    states: {},
  });
  const plugin = makePlugin(app);
  plugin.start({ totals: true });
  emitDelta(app, {
    context: 'vessels.self',
    updates: [{ values: [{ path: 'navigation.state', value: 'sailing' }] }],
  });
  await waitFor(() => app.statusMessages.some((m) => /new trip/i.test(m.msg)));

  // Entire value missing, and value with null coordinates: both must be
  // ignored (Number(null) is 0, so a NaN check alone would treat them as
  // a fix at 0,0).
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: null }] },
      { values: [{ path: 'navigation.position', value: { latitude: null, longitude: null } }] },
    ],
  });

  // A real fix after the nulls: the trip must not include any 0,0 jump.
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.0, longitude: 24.0 } }] },
    ],
  });
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.001, longitude: 24.0 } }] },
    ],
  });
  await waitForLogTotal(app, 100);
  plugin.stop();

  assert.strictEqual(app.errors.length, 0, `got ${JSON.stringify(app.errors)}`);
  const current = readLog(app, 'current');
  assert.ok(
    current.total > 0 && current.total < 1000,
    `null coordinates logged ${current.total} m; expected only the ~111 m real move`,
  );
});

test('implausible position jumps are skipped together with the matching jump back', async () => {
  const app = new FakeSignalKApp();
  seedLog(app, 'current', {
    started: '2026-01-01T00:00:00.000Z',
    ended: '2026-01-01T01:00:00.000Z',
    total: 0,
    states: {},
  });
  const plugin = makePlugin(app);
  plugin.start({ totals: true });
  emitDelta(app, {
    context: 'vessels.self',
    updates: [{ values: [{ path: 'navigation.state', value: 'sailing' }] }],
  });
  await waitFor(() => app.statusMessages.some((m) => /new trip/i.test(m.msg)));

  // First fix establishes the reference.
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.0, longitude: 24.0 } }] },
    ],
  });
  // Glitch: ~1000 km away (no timestamps, so the configured 10 s update
  // period gives ~54 000 kn), then the matching jump back near the start.
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 65.0, longitude: 24.0 } }] },
    ],
  });
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.0, longitude: 24.0 } }] },
    ],
  });
  // A normal small move afterwards must still be counted.
  emitDelta(app, {
    context: 'vessels.self',
    updates: [
      { values: [{ path: 'navigation.position', value: { latitude: 60.001, longitude: 24.0 } }] },
    ],
  });
  await waitForLogTotal(app, 100);
  plugin.stop();

  assert.ok(
    app.errors.some((m) => /implausible/i.test(m)),
    `expected skip reports, got ${JSON.stringify(app.errors)}`,
  );
  const current = readLog(app, 'current');
  assert.ok(
    current.total > 0 && current.total < 1000,
    `glitch logged ${current.total} m; expected only the ~111 m real move`,
  );
});

test('updates with non-advancing timestamps are skipped', async () => {
  const app = new FakeSignalKApp();
  seedLog(app, 'current', {
    started: '2026-01-01T00:00:00.000Z',
    ended: '2026-01-01T01:00:00.000Z',
    total: 0,
    states: {},
  });
  const plugin = makePlugin(app);
  plugin.start({ totals: true });
  emitDelta(app, {
    context: 'vessels.self',
    updates: [{ values: [{ path: 'navigation.state', value: 'sailing' }] }],
  });
  await waitFor(() => app.statusMessages.some((m) => /new trip/i.test(m.msg)));

  const update = (timestamp, latitude) => ({
    context: 'vessels.self',
    updates: [
      {
        timestamp,
        values: [{ path: 'navigation.position', value: { latitude, longitude: 24.0 } }],
      },
    ],
  });
  emitDelta(app, update('2026-11-02T17:00:00.000Z', 60.0));
  // Replayed delta with the same timestamp must not count again.
  emitDelta(app, update('2026-11-02T17:00:00.000Z', 60.001));
  // An advancing timestamp with a plausible move counts normally.
  emitDelta(app, update('2026-11-02T17:00:10.000Z', 60.001));
  await waitForLogTotal(app, 100);
  plugin.stop();

  const current = readLog(app, 'current');
  // 0.001° of latitude is ~111 m; a double count would be ~222 m.
  assert.ok(
    current.total > 0 && current.total < 200,
    `replayed update logged ${current.total} m; expected a single ~111 m move`,
  );
});
