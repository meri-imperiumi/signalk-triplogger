const { render } = require('mustache');
const { Point } = require('where');
const { load } = require('js-yaml');
const { readFile, writeFile } = require('node:fs/promises');

function isEnd(entry, nextEntry) {
  if (entry.text.indexOf('Anchored') !== -1) {
    return true;
  }
  if (!entry.end) {
    return false;
  }
  if (!nextEntry) {
    return true;
  }
  const current = new Date(entry.datetime);
  const next = new Date(nextEntry.datetime);
  const hours = (next - current) / 3600000;
  if (hours < 3) {
    return false;
  }
  return true;
}

readFile('2023-cruise.yml', 'utf-8')
  .then((yml) => load(yml))
  .then((data) => {
    const trips = [];
    let currentTrip = {
      events: [],
      sailing: 0,
    };
    let sailing = false;
    data.forEach((entry, idx) => {
      if (currentTrip.events.length === 0) {
        currentTrip.start = entry.datetime;
      }
      if (entry.text.indexOf('sailing') !== -1) {
        sailing = true;
      }
      if (entry.text.indexOf('Started main engine') !== -1) {
        sailing = false;
      }
      currentTrip.events.push(entry);
      if (isEnd(entry, data[idx + 1])) {
        currentTrip.end = entry.datetime;
        currentTrip.engineHours = (entry.engine.hours - currentTrip.events[0].engine.hours)
          .toFixed(1);
        currentTrip.miles = (entry.log - currentTrip.events[0].log).toFixed(1);
        trips.push(currentTrip);
        currentTrip = {
          events: [],
          sailing: 0,
        };
      }
    });
    return readFile('template.html', 'utf-8')
      .then(template => {
        return render(template, {
          trips,
          formatDate: () => (tmpl, rdr) => {
            const d = new Date(rdr(tmpl));
            return `${d.getUTCDate()}.${d.getMonth() + 1}. ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
          },
          formatTime: () => (tmpl, render) => {
            const d = new Date(render(tmpl));
            return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
          },
          formatWind: () => (tmpl, render) => {
            const wind = render(tmpl);
            if (wind === 'kt &deg;') {
              return 'n/a';
            }
            return wind;
          },
          formatBarometer: () => (tmpl, render) => {
            const baro = render(tmpl);
            return baro.split('.')[0];
          },
          formatCoordinates: () => (tmpl, render) => {
            const [ lat, lon ] = render(tmpl).split(' ');
            return new Point(parseFloat(lat), parseFloat(lon)).toString();
          },
        });
      });
  })
  .then(output => {
    writeFile('log.html', output, 'utf-8');
    console.log('Done');
  })
  .catch(e => {
    console.error(e.message);
    process.exit(1);
  });
