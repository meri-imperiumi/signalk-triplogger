/**
 * Shared test fakes: a mock Signal K app matching the patterns used by the
 * signalk-aprsfi-ais-reporter test suite, adapted for the triplogger's
 * needs (subscriptionmanager + handleMessage + setPluginStatus + data dir).
 *
 * @file fake-app.js
 */

/* eslint-disable class-methods-use-this */

const { join } = require('node:path');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');

/**
 * Minimal Signal K app fake with subscriptionmanager + handleMessage +
 * setPluginStatus + setProviderStatus + getDataDirPath + error.
 *
 * The data path is a fresh temp directory per instance so the Logger can
 * write log files without touching the project tree.
 */
class FakeSignalKApp {
  constructor() {
    this.selfId = 'urn:mrn:imo:mmsi:230999999';
    this.subscriptionmanager = {
      subscriptions: [],
      subscribe(subscription, unsubscribes, onError, onDelta) {
        this.subscriptions.push({ subscription, onDelta });
        unsubscribes.push(() => {
          const idx = this.subscriptions.findIndex(
            (s) => s.subscription === subscription,
          );
          if (idx >= 0) this.subscriptions.splice(idx, 1);
        });
      },
    };
    this.statusMessages = [];
    this.errors = [];
    this.messages = [];
    this.dataPath = mkdtempSync(join(tmpdir(), 'triplogger-test-'));
  }

  getDataDirPath() {
    return this.dataPath;
  }

  setPluginStatus = (msg) => {
    this.statusMessages.push({ type: 'status', msg });
  };

  setProviderStatus = (msg) => {
    this.statusMessages.push({ type: 'status', msg });
  };

  handleMessage = (sourceId, message) => {
    this.messages.push({ sourceId, message });
  };

  debug() {}

  error(msg) {
    this.errors.push(msg);
  }
}

/**
 * Emits a delta into the subscriptionmanager's registered handlers, for
 * tests that want to feed navigation values.
 *
 * @param {FakeSignalKApp} app
 * @param {object} delta
 * @returns {void}
 */
function emitDelta(app, delta) {
  app.subscriptionmanager.subscriptions.forEach(({ onDelta }) => onDelta(delta));
}

module.exports = { FakeSignalKApp, emitDelta };
