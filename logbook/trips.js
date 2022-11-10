const { Point, Geocoder } = require('where');
const { readFile } = require('node:fs/promises');
const promiseRetry = require('promise-retry')
const csvjson = require('csvjson');

function isUnderway(state) {
  if (state === 'motoring') {
    return true;
  }
  if (state === 'sailing') {
    return true;
  }
  return false;
}

function minutesElapsed(to, from) {
  return Math.floor(Math.abs(from - to) / 60 / 1000);
}

function ignoreShortSails(currentTrip, currentState) {
  if (currentTrip.events.length > 1
    && currentTrip.events[currentTrip.events.length - 1].state === 'sailing'
    && currentTrip.events[currentTrip.events.length - 2].state === 'motoring') {
    // We need to reject "sailing" false positives here.
    // These are "sailing entries about 10-25min long after motoring before mooring
    const sailingTime = currentTrip.events[currentTrip.events.length - 1].time;
    const stoppingTime = new Date(currentState.time);
    const elapsed = minutesElapsed(stoppingTime, sailingTime);
    if (elapsed <= 33) {
      // Less than half hour sailing is not sailing
      currentTrip.events.pop();
    }
  }
}

function collectTrips(startDate, endDate, client) {
  let query = `
    select first(stringValue) as "state"
    from "navigation.state"
    where time >= '${startDate}' and time <= '${endDate}'
    group by time(1m)
  `;
  return client
    .query(query)
    .then(result => {
      const trips = [];
      let lastState = null;
      let currentTrip = null;
      result.forEach((k) => {
        if (!k.state) {
          return;
        }
        if (k.state === lastState) {
          return;
        }
        if (isUnderway(k.state) && !isUnderway(lastState)) {
          // Trip start?
          const currentStart = new Date(k.time);
          if (trips.length > 0) {
            const lastTrip = trips[trips.length - 1];
            if (lastTrip.end
              && (lastTrip.end.toISOString().substring(0, 10) === currentStart.toISOString().substring(0, 10))) {
              // New trip on same date as previous, consider part of same trip
              currentTrip = trips.pop();
              currentTrip.events.push({
                time: currentStart,
                state: k.state,
              });
              lastState = k.state;
              return;
            }
          }
          currentTrip = {
            before: lastState,
            start: currentStart,
            events: [],
          };
        }
        if (!isUnderway(k.state) && isUnderway(lastState)) {
          ignoreShortSails(currentTrip, k);
          // Trip end
          currentTrip = {
            ...currentTrip,
            end: new Date(k.time),
            after: k.state,
          };
          currentTrip.events.push({
            time: new Date(k.time),
            state: k.state,
          });
          trips.push(currentTrip);
          currentTrip = null;
          lastState = k.state;
          return;
        }
        if (currentTrip) {
          ignoreShortSails(currentTrip, k);
          if (!currentTrip.events.length
            || (currentTrip.events.length
              && currentTrip.events[currentTrip.events.length - 1].state !== k.state)) {
            currentTrip.events.push({
              time: new Date(k.time),
              state: k.state,
            });
          }
        }
        lastState = k.state;
      });
      return trips;
    });
}

function addHourlies(trips) {
  trips.forEach(trip => {
    const startHour = trip.start.getUTCHours();
    let hourly = new Date(`${trip.start.toISOString().substring(0, 10)}T${String(startHour + 1).padStart(2, '0')}:00:00Z`);
    while (hourly < trip.end) {
      // Find position in events and inject (check that under way!)
      const before = trip.events.filter(e => e.time < hourly);
      if (before.length
        && isUnderway(before[before.length -1].state)) {
        const previousEvent = before[before.length - 1];
        const hourlyEvent = {
          state: previousEvent.state,
          time: hourly,
          hourly: true,
        };
        trip.events.splice(trip.events.indexOf(previousEvent) + 1, 0, hourlyEvent);
      }
      // Generate next hourly
      hourly = new Date(hourly.getTime() + 60 * 60 * 1000);
    }
  });
  return trips;
}

function addDatapoints(trips, key, values, minuteWindow = 2) {
  let currentTrip = trips[0];
  values.forEach(({time, value}) => {
    if (!currentTrip) {
      return;
    }
    currentTrip.events.forEach(state => {
      if (minutesElapsed(time, state.time) < minuteWindow) {
        state[key] = value;
        if (state === currentTrip.events[currentTrip.events.length - 1]) {
          // Trip ends here
          currentTrip = trips[trips.indexOf(currentTrip) + 1];
        }
      }
    });
  });
  return trips;
}

function collectPositions(trips, client) {
  if (trips.length === 0) {
    return Promise.resolve(trips);
  }
  const startTime = trips[0].start.toISOString();
  const endTime = trips[trips.length - 1].end.toISOString();
  let query = `
    select first(jsonValue) as "jsonPosition"
    from "navigation.position"
    where time >= '${startTime}' and time <= '${endTime}'
    group by time(1m)
  `;
  return client
    .query(query)
    .then(result => {
      const positionValues = result.map(positionEntry => {
        if (!positionEntry.jsonPosition) {
          return null;
        }
        const { latitude, longitude } = JSON.parse(positionEntry.jsonPosition);
        const position = new Point(latitude, longitude);
        return {
          time: new Date(positionEntry.time),
          value: new Point(latitude, longitude),
        };
      });
      addDatapoints(trips, 'position', positionValues.filter(p => p))
      // Add start/end positions
      trips.forEach(trip => {
        if (!trip.events.length) {
          return;
        }
        trip.startPosition = trip.events[0].position;
        trip.endPosition = trip.events[trip.events.length - 1].position;
      });
      return trips;
    });
}

function collectFixtype(trips, client) {
  if (trips.length === 0) {
    return Promise.resolve(trips);
  }
  const startTime = trips[0].start.toISOString();
  const endTime = trips[trips.length - 1].end.toISOString();
  let query = `
    select first(stringValue) as "value"
    from "navigation.gnss.type"
    where time >= '${startTime}' and time <= '${endTime}'
    group by time(1m)
  `;
  return client
    .query(query)
    .then(result => {
      addDatapoints(trips, 'fixType', result.filter(p => p), 30)
      return trips;
    });
}

function collectHeading(trips, client) {
  if (trips.length === 0) {
    return Promise.resolve(trips);
  }
  const startTime = trips[0].start.toISOString();
  const endTime = trips[trips.length - 1].end.toISOString();
  let query = `
    select mean(value) as "value"
    from "navigation.headingTrue"
    where time >= '${startTime}' and time <= '${endTime}'
    group by time(1m)
  `;
  return client
    .query(query)
    .then(result => {
      const values = result.map(entry => {
        let degrees = (entry.value * 180 / Math.PI);
        if (degrees > 360) {
          degrees = degrees - 360;
        }
        return {
          time: new Date(entry.time),
          value: degrees.toFixed(0).padStart(3, 0),
        };
      });
      addDatapoints(trips, 'heading', values.filter(p => p))
      return trips;
    });
}

function collectSpeed(trips, client) {
  if (trips.length === 0) {
    return Promise.resolve(trips);
  }
  const startTime = trips[0].start.toISOString();
  const endTime = trips[trips.length - 1].end.toISOString();
  let query = `
    select mean(value) as "value"
    from "navigation.speedOverGround"
    where time >= '${startTime}' and time <= '${endTime}'
    group by time(1m)
  `;
  return client
    .query(query)
    .then(result => {
      const values = result.map(entry => {
        return {
          time: new Date(entry.time),
          value: (entry.value * 1.943844).toFixed(1),
        };
      });
      addDatapoints(trips, 'speed', values.filter(p => p))
      return trips;
    });
}

function collectLog(trips, client) {
  if (trips.length === 0) {
    return Promise.resolve(trips);
  }
  const startTime = trips[0].start.toISOString();
  const endTime = trips[trips.length - 1].end.toISOString();
  let query = `
    select mean(value) as "value"
    from "navigation.trip.log"
    where time >= '${startTime}' and time <= '${endTime}'
    group by time(1m)
  `;
  return client
    .query(query)
    .then(result => {
      const values = result.map(entry => {
        return {
          time: new Date(entry.time),
          value: (entry.value * 0.0005399568).toFixed(1),
        };
      });
      addDatapoints(trips, 'log', values.filter(p => p))
      return trips;
    });
}

function collectBarometer(trips, client) {
  if (trips.length === 0) {
    return Promise.resolve(trips);
  }
  const startTime = trips[0].start.toISOString();
  const endTime = trips[trips.length - 1].end.toISOString();
  let query = `
    select mean(value) as "value"
    from "environment.outside.pressure"
    where time >= '${startTime}' and time <= '${endTime}'
    group by time(1m)
  `;
  return client
    .query(query)
    .then(result => {
      const values = result.map(entry => {
        return {
          time: new Date(entry.time),
          value: (entry.value / 100).toFixed(2),
        };
      });
      addDatapoints(trips, 'barometer', values.filter(p => p))
      return trips;
    });
}

function collectWind(trips, client) {
  if (trips.length === 0) {
    return Promise.resolve(trips);
  }
  const startTime = trips[0].start.toISOString();
  const endTime = trips[trips.length - 1].end.toISOString();
  let speedQuery = `
    select mean(value) as "value"
    from "environment.wind.speedOverGround"
    where time >= '${startTime}' and time <= '${endTime}'
    group by time(1m)
  `;
  let directionQuery = `
    select mean(value) as "value"
    from "environment.wind.directionTrue"
    where time >= '${startTime}' and time <= '${endTime}'
    group by time(1m)
  `;
  return client
    .query(speedQuery)
    .then(result => {
      const values = result.map(entry => {
        return {
          time: new Date(entry.time),
          value: (entry.value * 1.943844).toFixed(1),
        };
      });
      addDatapoints(trips, 'windSpeed', values.filter(p => p))
      return client
        .query(directionQuery)
        .then(directionResult => {
          const directionValues = directionResult.map(entry => {
            let degrees = (entry.value * 180 / Math.PI);
            return {
              time: new Date(entry.time),
              value: degrees.toFixed(0).padStart(3, 0),
            };
          });
          addDatapoints(trips, 'windDirection', directionValues.filter(p => p))
          return trips;
        });
    })
}

function collectAnnotations(trips) {
  return readFile('annotations.json', 'utf-8')
    .then(data => JSON.parse(data))
    .catch(() => [])
    .then(annotations => {
      trips.forEach(t => {
        t.events.forEach(e => {
          const timestamp = e.time.toISOString();
          const annotation = annotations.find(a => a.time === timestamp);
          if (annotation) {
            e.originalState = e.state;
            e.state = annotation.value;
          }
        });
      });
      return trips;
    });
}

function parseSailloggerTime(time) {
  const [dateString, timeString] = time.split(', ');
  const [day, month, year] = dateString.split('/');
  return new Date(`${year}-${month}-${day}T${timeString}`);
}

function collectSaillogger(trips) {
  return readFile('saillog.csv', 'utf-8')
    .then(data => csvjson.toObject(data, {
        quote     : '"',
    }))
    .catch(() => [])
    .then(lines => {
      const logs = lines.map((line) => {
        return {
          startLocation: line.From,
          endLocation: line.To,
          start: parseSailloggerTime(line.Started),
          end: parseSailloggerTime(line.Ended),
        };
      });
      trips.forEach(t => {
        logs.find(l => {
          const elapsedStart = minutesElapsed(t.start, l.start);
          const elapsedEnd = minutesElapsed(t.end, l.end);
          if (elapsedStart < 60) {
            t.startLocation = l.startLocation;
          }
          if (elapsedEnd < 60) {
            t.endLocation = l.endLocation;
          }
        });
      });
      return trips;
    });
}

function positionLabel(location) {
  const parts = [];
  if (location.address.leisure) {
    parts.push(location.address.leisure);
  }
  if (location.address.village) {
    parts.push(location.address.village);
  }
  if (location.address.hamlet) {
    parts.push(location.address.hamlet);
  }
  if (location.address.isolated_dwelling && parts.length === 0) {
    parts.push(location.address.isolated_dwelling);
  }
  if (location.address.suburb) {
    parts.push(location.address.suburb);
  }
  if (location.address.city) {
    parts.push(location.address.city);
  }
  if (parts.length) {
    return parts.join(', ');
  }
  console.log('FALLBACK');
  console.log(location);
  return location.display_name;
}

function retriedGeocode(geocoder, position) {
  return Promise.reject(new Error('Disabled'));
  return promiseRetry((retry, number) => {
    return geocoder.fromPoint(position)
      .catch((e) => {
        console.log(e);
        retry(e);
      });
  });
} 

function geoCode(trips) {
  const geocoder = new Geocoder();
  return trips.reduce((cur, t, idx) => {
    return cur
      .then(() => {
        if (t.startLocation) {
          return Promise.resolve();
        }
        if (idx === 0) {
          // For the first entry we need to geocode start location
          return retriedGeocode(geocoder, t.startPosition)
            .then(start => {
              t.startLocation = positionLabel(start);
              return Promise.resolve();
            }, (e) => {
              // Geocoding failed
              t.startLocation = t.startPosition.toString();
            });
        }
        // For the rest, we can use previous end location
        t.startLocation = trips[idx - 1].endLocation;
        return Promise.resolve();
      })
      .then(() => {
        if (t.endLocation) {
          return Promise.resolve();
        }
        return retriedGeocode(geocoder, t.endPosition)
        .then(end => {
          t.endLocation = positionLabel(end);
        }, (e) => {
          // Geocoding failed
          t.endLocation = t.endPosition.toString();
        });
      });
  }, Promise.resolve())
  .then(() => trips);
}

module.exports = {
  collectTrips,
  collectPositions,
  collectFixtype,
  collectSpeed,
  collectLog,
  collectHeading,
  collectBarometer,
  collectWind,
  collectAnnotations,
  collectSaillogger,
  addHourlies,
  geoCode,
};
