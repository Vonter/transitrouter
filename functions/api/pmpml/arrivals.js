/**
 * Cloudflare Pages Function for PMPML Live Arrival Data (GTFS-RT variant)
 * Endpoint: /api/pmpml-gtfs/arrivals?stationid=41
 *
 * ETAs come from GTFS-RT TripUpdates for this stop when the feed publishes
 * them for it; otherwise this falls back to the PMPML PIS API (as functions
 * /pmpml does). The feed only publishes VehiclePositions today, so this
 * always falls back for now, but it's written to switch over on its own
 * once TripUpdates are added. Either way, vehicle locations used to enrich
 * each trip come from the GTFS-RT VehiclePositions feed.
 */
import { fetchGtfsRtFeed, buildVehicleLocationLookup } from './pmpml-rt.js';
import ROUTE_MAPPING from './pmpml-route-mapping.js';

// Reverse of ROUTE_MAPPING (route_id -> public route number), to resolve a
// TripUpdate's route_id back to the number riders recognize. See the
// caveat in pmpml-rt.js for what this route_id actually is.
const ROUTE_ID_TO_NAME = Object.fromEntries(
  Object.entries(ROUTE_MAPPING).flatMap(([name, ids]) => ids.map((id) => [id, name])),
);

const PMPML_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0',
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'x-api-key': 't',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const MAX_MS = 90 * 60 * 1000;

function jsonResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const stationId = new URL(request.url).searchParams.get('stationid');

    if (!stationId) {
      return jsonResponse({ error: 'stationid parameter is required' }, 400);
    }

    const cacheHeaders = { 'Cache-Control': 'public, max-age=10' };

    let feed = { vehicles: [], tripUpdates: [] };
    try {
      feed = await fetchGtfsRtFeed();
    } catch (error) {
      console.error('GTFS-RT feed fetch failed, falling back to PMPML PIS API:', error);
    }

    // Prefer GTFS-RT TripUpdates for this stop, once the feed publishes them.
    if (feed.tripUpdates.length > 0) {
      const vehicleLocations = buildVehicleLocationLookup(feed.vehicles);
      const services = convertTripUpdatesToServices(feed.tripUpdates, stationId, vehicleLocations);
      if (services.length > 0) {
        return jsonResponse({ services }, 200, cacheHeaders);
      }
      // No TripUpdate covers this specific stop yet — fall through to the PIS API.
    }

    const res = await fetch(
      'https://prod-pmpml-pis.chartr.in/get_buses_eta',
      {
        method: 'POST',
        headers: PMPML_HEADERS,
        body: JSON.stringify({ device_id: '', source: 'stops', stop_id: parseInt(stationId), user_lat: 18.35, user_lon: 73.65 }),
      },
    );

    if (!res.ok) throw new Error(`PMPML API returned ${res.status}`);

    const result = await res.json();

    if (!(result.message.toLowerCase() === 'success')) {
      return jsonResponse({ services: [] }, 200, cacheHeaders);
    }

    const services = convertPMPMLToServices(result.buses, feed.vehicles);
    return jsonResponse({ services }, 200, cacheHeaders);
  } catch (error) {
    console.error('PMPML API Function Error:', error);
    return jsonResponse(
      { error: 'Failed to fetch arrival data', message: error.message },
      500,
    );
  }
}

function convertTripUpdatesToServices(tripUpdates, stationId, vehicleLocations) {
  const nowMs = Date.now();
  const servicesMap = new Map();

  for (const tu of tripUpdates) {
    for (const stu of tu.stopTimeUpdates) {
      if (stu.stopId !== stationId) continue;

      const eventTime = stu.arrival?.time ?? stu.departure?.time;
      if (eventTime == null) continue;

      const duration_ms = eventTime * 1000 - nowMs;
      if (duration_ms < 0 || duration_ms > MAX_MS) continue;

      const routeName = (tu.routeId && ROUTE_ID_TO_NAME[tu.routeId]) || tu.routeId;
      const key = routeName || tu.tripId;
      if (!servicesMap.has(key)) {
        servicesMap.set(key, { no: routeName || tu.tripId, destination: null, trips: [] });
      }

      const location = (tu.vehicleId && vehicleLocations.get(tu.vehicleId)) || null;

      servicesMap.get(key).trips.push({
        duration_ms,
        type: 'SD',
        load: 'SEA',
        feature: 'WAB',
        visit_number: 1,
        origin_code: '',
        destination_code: null,
        vehicle_id: tu.vehicleId,
        bus_no: tu.vehicleId,
        location,
      });
    }
  }

  return buildServicesFromTrips(servicesMap);
}

function convertPMPMLToServices(data, vehicles) {
  const vehicleLocations = buildVehicleLocationLookup(vehicles);

  // Group trips into services
  const servicesMap = new Map();
  for (const route of data) {
    for (const trip of route.etas) {
      const duration_ms = trip.eta*1000*60; // minutes to seconds to milliseconds
      if (duration_ms < 0 || duration_ms > MAX_MS) continue;

      if(!servicesMap.has(route.route_long_name)) {
        servicesMap.set(route.route_long_name, {
          no: route.route_long_name.replace('UP', '').replace('DOWN', ''),
          destination: route.terminal_stop,
          trips: []
        });
      }

      const location =
        (trip.vehicle_id && vehicleLocations.get(trip.vehicle_id)) ||
        null;
      servicesMap.get(route.route_long_name).trips.push({
        duration_ms,
        type: 'SD',
        load: 'SEA',
        feature: 'WAB',
        visit_number: 1,
        origin_code: '',
        destination_code: route.terminal_stop,
        vehicle_id: trip.vehicle_id,
        bus_no: trip.vehicle_id,
        location,
      })
    }
  }

  return buildServicesFromTrips(servicesMap);
}

function buildServicesFromTrips(servicesMap) {
  return Array.from(servicesMap.values()).map(({ no, destination, trips }) => {
    trips.sort((a, b) => a.duration_ms - b.duration_ms);
    const service = { no, destination, frequency: trips.length };
    if (trips[0]) service.next = trips[0];
    if (trips[1]) service.next2 = trips[1];
    if (trips[2]) service.next3 = trips[2];
    return service;
  });
}
