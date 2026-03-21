import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import circle from '@turf/circle';
import { round } from '@turf/helpers';

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import config from assets/city-config.js
const configPath = path.join(__dirname, '../assets/city-config.js');
const configModule = await import(configPath);
const { DEFAULT_CITY } = configModule;

// Parse command-line arguments
const args = process.argv.slice(2);
const cityArg = args.find((arg) => arg.startsWith('--city='));
const city = cityArg ? cityArg.split('=')[1] : DEFAULT_CITY;

console.log(`Building stops for city: ${city}`);

// Read local files
const dataDir = path.join(process.cwd(), 'data', city);
const outputDir = path.join(process.cwd(), 'visualization', 'data', city);

const stopsMin = JSON.parse(fs.readFileSync(path.join(dataDir, 'stops.min.json'), 'utf-8'));
const servicesData = JSON.parse(fs.readFileSync(path.join(dataDir, 'services.min.json'), 'utf-8'));
const levels = JSON.parse(fs.readFileSync(path.join(outputDir, 'levels.json'), 'utf-8'));

// Create GeoJSON features from stops
const stopsFeatures = Object.entries(stopsMin).map(([number, data]) => {
  // Get services that use this stop
  const services = Object.entries(servicesData)
    .filter(([_, serviceData]) => {
      return serviceData.routes.some((route) => route.includes(number));
    })
    .map(([serviceName]) => serviceName);

  return {
    type: 'Feature',
    properties: {
      number,
      name: data[2],
      services,
    },
    geometry: {
      type: 'Point',
      coordinates: [data[0], data[1]], // lng, lat
    },
  };
});

console.log(`Total stops: ${stopsFeatures.length}`);

const data = stopsFeatures.map((f) => {
  f.geometry.coordinates.forEach((c) => round(c, 5));
  const feature = circle(f, 0.015, { steps: 3 });
  return {
    ...f.properties,
    level: levels[f.properties.number],
    contour: feature.geometry.coordinates,
  };
});

const stopsFile = path.join(outputDir, 'stops.3d.json');
fs.writeFileSync(stopsFile, JSON.stringify(data, null, ' '));
console.log(`File generated: ${stopsFile}`);
