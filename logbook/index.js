const Influx = require('influx');
const tripFunctions = require('./trips');
const { writeFile } = require('node:fs/promises');

/**
 * Data needed:
 * Header:
 *   - Date
 *   - From location
 *   - To location
 *   - End date
 * Rows:
 *   - Time
 *   - COG
 *   - HDG
 *   - Log distance
 *   - Wind speed
 *   - Baro
 *   - Coordinates
 *   - Event (hourly entry, motor on, etc)
 * Footer:
 *   - Distance run
 *   - Engine hours
 */

const database = 'lille-oe';
const selfContext = 'vessels.211692440';
const influxOptions = {
  host: '192.168.1.105',
  port: 8086,
  database,
};
const startDate = '2022-04-15T06:00:00Z';
//const startDate = '2022-09-08T06:00:00Z';
const endDate = '2022-09-16T18:00:00Z';



const client = new Influx.InfluxDB(influxOptions);
client
  .getDatabaseNames()
  .then(names => {
    if (!names.includes(database)) {
      throw new Exception(`Database ${database} not found`);
    }
  })
  .then(() => {
    return tripFunctions.collectTrips(startDate, endDate, client);
  })
  .then(trips => {
    return tripFunctions.addHourlies(trips);
  })
  .then(trips => {
    return tripFunctions.collectSpeed(trips, client);
  })
  .then(trips => {
    return tripFunctions.collectHeading(trips, client);
  })
  .then(trips => {
    return tripFunctions.collectBarometer(trips, client);
  })
  .then(trips => {
    return tripFunctions.collectWind(trips, client);
  })
  .then(trips => {
    return tripFunctions.collectPositions(trips, client);
  })
  .then(trips => {
    return tripFunctions.geoCode(trips);
  })
  .then(trips => {
    return writeFile('2022.json', JSON.stringify(trips, 0, 2), 'utf-8')
      .then(() => trips);
  })
  .catch(e => {
    console.error(e.message);
    process.exit(1);
  });
