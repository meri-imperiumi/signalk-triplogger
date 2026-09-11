/**
 * Smoke tests for the Logger: persistence, atomic saves, and recovery
 * from corrupt or empty log files.
 * @file logger.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const Logger = require('../Logger');

/**
 * Build a Logger with a fresh temp directory, a log filename inside it,
 * and an error collector for the onError callback.
 *
 * @returns {{dir: string, filename: string, logger: Logger, errors: string[]}}
 */
function makeLogger() {
  const dir = mkdtempSync(join(tmpdir(), 'triplogger-logger-'));
  const filename = join(dir, '2026-09-11.json');
  const errors = [];
  const logger = new Logger(filename, (message) => errors.push(message));
  return {
    dir,
    filename,
    logger,
    errors,
  };
}

/**
 * Read a file in the logger's directory as JSON.
 *
 * @param {string} dir
 * @param {string} name file name without directory
 * @returns {object}
 */
function readJson(dir, name) {
  return JSON.parse(readFileSync(join(dir, name), 'utf-8'));
}

test('save persists the log as valid JSON and leaves no temp files', async () => {
  const { dir, filename, logger } = makeLogger();
  logger.setState('sailing');
  logger.appendTrip(1000);
  await logger.save();

  const persisted = readJson(dir, '2026-09-11.json');
  assert.strictEqual(persisted.total, 1000);
  assert.strictEqual(persisted.states.sailing, 1000);
  assert.ok(!existsSync(`${filename}.tmp`), 'temp file was left behind');
});

test('load restores a persisted log', async () => {
  const { filename } = makeLogger();
  const first = new Logger(filename);
  first.setState('motoring');
  first.appendTrip(500);
  await first.save();

  const errors = [];
  const second = new Logger(filename, (m) => errors.push(m));
  await second.load();
  assert.strictEqual(second.toJSON().total, 500);
  assert.strictEqual(second.toJSON().states.motoring, 500);
  assert.strictEqual(errors.length, 0);
});

test('overlapping saves persist the newest state without corrupting the file', async () => {
  const { dir, filename, logger } = makeLogger();
  logger.appendTrip(1);
  const first = logger.save();
  // Mutate while the first save is still in flight
  logger.appendTrip(2);
  const second = logger.save();
  await Promise.all([first, second]);

  assert.strictEqual(readJson(dir, '2026-09-11.json').total, 3);
  assert.ok(!existsSync(`${filename}.tmp`), 'temp file was left behind');
});

test('load recovers from a truncated log file by backing it up', async () => {
  const {
    dir,
    filename,
    logger,
    errors,
  } = makeLogger();
  const corrupt = '{"started": "2026-09-11T00:00:00.000Z", "total": 50';
  writeFileSync(filename, corrupt, 'utf-8');

  await logger.load();

  // The corrupt contents are preserved for manual recovery
  assert.ok(existsSync(`${filename}.corrupt`), 'no .corrupt backup was made');
  assert.strictEqual(readFileSync(`${filename}.corrupt`, 'utf-8'), corrupt);
  // The corruption was reported
  assert.ok(errors.length > 0, 'corruption was not reported via onError');
  assert.match(errors[0], /corrupt/i);
  // The logger works from a fresh log afterwards
  assert.strictEqual(logger.toJSON().total, 0);
  logger.appendTrip(100);
  await logger.save();
  assert.strictEqual(readJson(dir, '2026-09-11.json').total, 100);
});

test('load recovers from an empty log file', async () => {
  const {
    dir,
    filename,
    logger,
    errors,
  } = makeLogger();
  writeFileSync(filename, '', 'utf-8');

  await logger.load();

  assert.ok(existsSync(`${filename}.corrupt`));
  assert.ok(errors.length > 0, 'corruption was not reported via onError');
  logger.appendTrip(100);
  await logger.save();
  assert.strictEqual(readJson(dir, '2026-09-11.json').total, 100);
});

test('load recovers from a log file containing a JSON scalar', async () => {
  const { filename, logger, errors } = makeLogger();
  writeFileSync(filename, 'null', 'utf-8');

  await logger.load();

  assert.ok(existsSync(`${filename}.corrupt`));
  assert.ok(errors.length > 0, 'corruption was not reported via onError');
  assert.strictEqual(logger.toJSON().total, 0);
});

test('load still rejects on read errors', async () => {
  const { filename } = makeLogger();
  const logger = new Logger(filename);
  await assert.rejects(() => logger.load(), /ENOENT/);
});
