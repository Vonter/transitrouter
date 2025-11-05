import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import simplify from '@turf/simplify';
import CheapRuler from 'cheap-ruler';
import polyline from '@mapbox/polyline';

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import config from assets/city-config.js
const configPath = path.join(__dirname, '../assets/city-config.js');
const configModule = await import(configPath);
const { DEFAULT_CITY, getConfigForCity } = configModule;

// Parse command-line arguments
const args = process.argv.slice(2);
const cityArg = args.find((arg) => arg.startsWith('--city='));
const city = cityArg ? cityArg.split('=')[1] : DEFAULT_CITY;

console.log(`Building routes for city: ${city}`);

// Get city config
const cityConfig = getConfigForCity(city);
const { bounds } = cityConfig.city;

// Calculate center for CheapRuler
const centerLat = (bounds.lowerLat + bounds.upperLat) / 2;
const ruler = new CheapRuler(centerLat);

// Read local files
const dataDir = path.join(process.cwd(), 'data', city);
const stopsMin = JSON.parse(fs.readFileSync(path.join(dataDir, 'stops.min.json'), 'utf-8'));
const stops = {};
Object.entries(stopsMin).forEach(([number, data]) => {
  stops[number] = {
    lng: data[0],
    lat: data[1],
    name: data[2],
  };
});
const stopsArr = Object.keys(stops).map((s) => ({
  no: s,
  ...stops[s],
}));

const routesEncoded = JSON.parse(fs.readFileSync(path.join(dataDir, 'routes.min.json'), 'utf-8'));
const serviceStops = JSON.parse(fs.readFileSync(path.join(dataDir, 'services.min.json'), 'utf-8'));

// Decode polylines and create GeoJSON features
const routes = [];
Object.entries(routesEncoded).forEach(([number, polylines]) => {
  polylines.forEach((encodedPolyline, index) => {
    try {
      const coordinates = polyline.decode(encodedPolyline).map(([lat, lng]) => [lng, lat]);
      routes.push({
        type: 'Feature',
        properties: { number },
        geometry: {
          type: 'LineString',
          coordinates,
        },
      });
    } catch (err) {
      console.warn(`Failed to decode polyline for route ${number}[${index}]:`, err.message);
    }
  });
});

// Sort routes by length - shortest to furthest
const sortedRoutes = routes.sort(
  (a, b) =>
    ruler.lineDistance(a.geometry.coordinates) -
    ruler.lineDistance(b.geometry.coordinates),
);

// Services, sorted by route length
const sortedServices = sortedRoutes
  .map((r) => r.properties.number)
  .filter((el, pos, arr) => {
    return arr.indexOf(el) == pos;
  });
let mostHighestLevel = 0;
const newRoutes = [];

sortedServices.forEach((service) => {
  const _stops = serviceStops[service].routes;
  const allStops = [...new Set([..._stops[0], ...(_stops[1] || [])])];
  // const highestLevel = allStops.reduce((acc, s) => Math.max(stops[s].level || 0, acc), 0);
  // const level = highestLevel + 1;
  let level = null;
  for (let l = 1; !level; l++) {
    const hasLevel = allStops.some((s) =>
      stops[s].occupiedLevels ? stops[s].occupiedLevels.has(l) : false,
    );
    if (!hasLevel) level = l;
  }
  allStops.forEach((s) => {
    // stops[s].level = level;
    if (stops[s].occupiedLevels) {
      stops[s].occupiedLevels.add(level);
    } else {
      stops[s].occupiedLevels = new Set([level]);
    }
  });
  const serviceRoutes = routes.filter((r) => r.properties.number === service);
  serviceRoutes.forEach((serviceRoute) => {
    const simplifiedServiceRoute = simplify(serviceRoute, {
      tolerance: 0.0005,
      highQuality: true,
      mutate: true,
    });
    newRoutes.push({
      level,
      number: serviceRoute.properties.number,
      path: simplifiedServiceRoute.geometry.coordinates.map((c) =>
        c.concat((level - 1) * 100),
      ),
    });
  });
  console.log(`${service} - level ${level}`);
  if (level > mostHighestLevel) mostHighestLevel = level;
});

console.log(`Highest level: ${mostHighestLevel}`);

// Create output directory if it doesn't exist
const outputDir = path.join(process.cwd(), 'visualization', 'data', city);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const routesFile = path.join(outputDir, 'routes.json');
fs.writeFileSync(routesFile, JSON.stringify(newRoutes, null, ' '));
console.log(`File generated: ${routesFile}`);

const stopLevels = {};
stopsArr.forEach((s) => {
  const { occupiedLevels } = stops[s.no];
  if (occupiedLevels && occupiedLevels.size > 0) {
    const highestLevel = Math.max(...occupiedLevels);
    stopLevels[s.no] = highestLevel;
  } else {
    // Stop not used by any service, assign default level
    stopLevels[s.no] = 1;
  }
});

const levelsFile = path.join(outputDir, 'levels.json');
fs.writeFileSync(levelsFile, JSON.stringify(stopLevels, null, ' '));
console.log(`File generated: ${levelsFile}`);
