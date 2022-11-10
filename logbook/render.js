const { render } = require('mustache');
const { Point } = require('where');
const data = require('./2022-logs.json');
const { readFile, writeFile } = require('node:fs/promises');

let previousState = null;

readFile('template.html', 'utf-8')
  .then(template => {
    return render(template, {
      trips: data,
      formatDate: () => (tmpl, render) => {
        const d = new Date(render(tmpl));
        return `${d.getUTCDate()}.${d.getMonth()+1}. ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
      },
      formatTime: () => (tmpl, render) => {
        const d = new Date(render(tmpl));
        return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
      },
      formatWind: () => (tmpl, render) => {
        const wind = render(tmpl);
        if (wind === '0.0kt 000&deg;') {
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
      formatState: () => (tmpl, render) => {
        const prev = previousState;
        const state = render(tmpl);
        previousState = state;
        switch (state) {
          case 'sailing':
            if (prev === 'motoring') {
              return 'Motor stopped, sails up';
            }
            return 'Sails up';
          case 'motoring':
            if (prev === 'sailing') {
              return 'Motor started, sails down';
            }
            if (prev === 'anchored') {
              return 'Motor started, anchor up';
            }
            return 'Motor started';
          case 'moored':
            return 'Vessel stopped';
          case 'anchored':
            return 'Anchored';
          default:
            return state;
        }
      },
    });
  })
  .then(output => {
    return writeFile('log.html', output, 'utf-8');
  })
  .catch(e => {
    console.error(e.message);
    process.exit(1);
  });
