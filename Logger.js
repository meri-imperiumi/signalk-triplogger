const fs = require('fs');

function toNM(meters) {
  return (meters / 1852).toFixed(2);
}

class Logger {
  constructor(filename) {
    this.state = null;
    this.filename = filename;
    this.reset();
    this.unsaved = false;
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
    if (!this.unsaved) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      fs.writeFile(this.filename, JSON.stringify(this.log, null, 2), (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
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
        this.log = JSON.parse(contents);
        this.unsaved = false;
        resolve();
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
