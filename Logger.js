const fs = require('fs');
const { promisify } = require('util');

const fsWriteFile = promisify(fs.writeFile);
const fsOpen = promisify(fs.open);
const fsFsync = promisify(fs.fsync);
const fsClose = promisify(fs.close);
const fsRename = promisify(fs.rename);

function toNM(meters) {
  return (meters / 1852).toFixed(2);
}

class Logger {
  constructor(filename, onError) {
    this.state = null;
    this.filename = filename;
    this.onError = onError;
    this.reset();
    this.unsaved = false;
    this.saves = Promise.resolve();
  }

  reset() {
    this.log = {
      started: new Date(),
      ended: null,
      total: 0,
      states: {},
    };
    this.unsaved = true;
  }

  inTrip() {
    if (this.state === null && this.log.started && !this.log.ended) {
      return true;
    }
    if (this.state === 'sailing' || this.state === 'motoring') {
      return true;
    }
    return false;
  }

  setState(state) {
    if (this.state === state) {
      return;
    }
    this.state = state;
    if (!this.log.states) {
      this.log.states = {};
    }
    if (!this.log.states[state]) {
      this.log.states[state] = 0;
    }
    this.unsaved = true;
  }

  appendTrip(distance) {
    if (this.log.ended || !this.inTrip()) {
      return;
    }
    if (!this.log.total) {
      this.log.total = 0;
    }
    this.log.total += distance;
    this.unsaved = true;
    if (!this.state) {
      return;
    }
    if (!this.log.states[this.state]) {
      this.log.states[this.state] = 0;
    }
    this.log.states[this.state] += distance;
  }

  endTrip() {
    this.log.ended = new Date();
    return this.save();
  }

  save() {
    // Serialize writes: concurrent saves writing to the same temp file
    // could interleave, and an older snapshot could be renamed over a
    // newer one. Each save runs only after the previous one settles.
    const previous = this.saves;
    this.saves = previous.then(
      () => this.write(),
      () => this.write(),
    );
    return this.saves;
  }

  async write() {
    if (!this.unsaved) {
      return;
    }
    const tmpFile = `${this.filename}.tmp`;
    await fsWriteFile(tmpFile, JSON.stringify(this.log, null, 2));
    // Flush the temp file to disk before renaming: without fsync, a
    // power loss can persist the rename while the file's contents never
    // made it to disk, recreating a truncated log
    const fd = await fsOpen(tmpFile, 'r+');
    try {
      await fsFsync(fd);
    } finally {
      await fsClose(fd);
    }
    // Rename over an existing file is atomic: readers see either the
    // old log or the new one, never a partially written one
    await fsRename(tmpFile, this.filename);
    this.unsaved = false;
  }

  exists() {
    return new Promise((resolve) => {
      fs.stat(this.filename, (err) => {
        if (err) {
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }

  load() {
    return new Promise((resolve, reject) => {
      fs.readFile(this.filename, 'utf-8', (err, contents) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          const parsed = JSON.parse(contents);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Not a JSON object');
          }
          this.log = parsed;
          this.unsaved = false;
          resolve();
        } catch (parseError) {
          // Corrupt (for example truncated by a crash mid-write) or empty
          // log file. Back it up for manual recovery and start a fresh log
          // instead of failing the whole plugin.
          const backup = `${this.filename}.corrupt`;
          fs.rename(this.filename, backup, () => {
            this.reset();
            if (this.onError) {
              this.onError(
                `Corrupt log file ${this.filename} (${parseError.message}). Backed up to ${backup}, starting a fresh log`,
              );
            }
            resolve();
          });
        }
      });
    });
  }

  toJSON() {
    return this.log;
  }

  toString() {
    return `${toNM(this.log.total)}NM since ${this.log.started}`;
  }
}

module.exports = Logger;
