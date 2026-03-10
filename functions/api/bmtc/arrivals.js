/**
 * Cloudflare Pages Function for BMTC Live Arrival Data
 * Endpoint: /api/bmtc/arrivals?stationid=20820
 */
import BLR_ROUTE_MAPPING from './blr-route-mapping.js';

const BMTC_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0',
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  lan: 'en',
  deviceType: 'WEB',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

    const res = await fetch(
      'https://bmtcmobileapi.karnataka.gov.in/WebAPI/GetMobileTripsData',
      {
        method: 'POST',
        headers: BMTC_HEADERS,
        body: JSON.stringify({ stationid: parseInt(stationId), triptype: 1 }),
      },
    );

    if (!res.ok) throw new Error(`BMTC API returned ${res.status}`);

    const result = await res.json();
    const cacheHeaders = { 'Cache-Control': 'public, max-age=10' };

    if (!result.Issuccess || !result.data?.length) {
      return jsonResponse({ services: [] }, 200, cacheHeaders);
    }

    const services = await convertBMTCToServices(result.data);
    return jsonResponse({ services }, 200, cacheHeaders);
  } catch (error) {
    console.error('BMTC API Function Error:', error);
    return jsonResponse(
      { error: 'Failed to fetch arrival data', message: error.message },
      500,
    );
  }
}

// Parse "DD-MM-YYYY HH:MM:SS" (IST) to a Date
function parseBMTCDate(dateString) {
  const [date, time = '00:00:00'] = dateString.split(' ');
  const [dd, mm, yyyy] = date.split('-');
  return new Date(`${yyyy}-${mm}-${dd}T${time}+05:30`);
}

async function fetchVehicleDataForRoute(routeId) {
  try {
    const res = await fetch(
      'https://bmtcmobileapi.karnataka.gov.in/WebAPI/SearchByRouteDetails_v4',
      {
        method: 'POST',
        headers: BMTC_HEADERS,
        body: JSON.stringify({
          routeid: parseInt(routeId, 10),
          servicetypeid: 0,
        }),
      },
    );

    if (!res.ok) return null;

    const result = await res.json();
    const vehicles = new Map();

    for (const dir of [result.up, result.down]) {
      dir?.data?.forEach((station) =>
        station.vehicleDetails?.forEach((v) => {
          if (!v.centerlat || !v.centerlong) return;
          const loc = {
            lat: parseFloat(v.centerlat),
            lng: parseFloat(v.centerlong),
          };
          if (v.vehicleid && !vehicles.has(v.vehicleid))
            vehicles.set(v.vehicleid, loc);
          if (v.vehiclenumber && !vehicles.has(v.vehiclenumber))
            vehicles.set(v.vehiclenumber, loc);
        }),
      );
    }

    return vehicles;
  } catch (error) {
    console.error(`Error fetching vehicle data for route ${routeId}:`, error);
    return null;
  }
}

async function convertBMTCToServices(data) {
  const now = new Date();
  const MAX_MS = 90 * 60 * 1000;

  // Resolve unique route IDs for trips that have a GPS vehicle
  const routeIds = new Map();
  for (const trip of data) {
    if (trip.vehicleid && !routeIds.has(trip.routeno)) {
      const routeId = BLR_ROUTE_MAPPING[trip.routeno];
      if (routeId) routeIds.set(trip.routeno, routeId);
    }
  }

  // Fetch vehicle locations for all routes in parallel
  const allVehicles = new Map();
  await Promise.all(
    Array.from(routeIds.values()).map(async (routeId) => {
      const vehicles = await fetchVehicleDataForRoute(routeId);
      vehicles?.forEach((loc, key) => allVehicles.set(key, loc));
    }),
  );

  // Group trips into services
  const servicesMap = new Map();
  for (const trip of data) {
    const duration_ms = parseBMTCDate(trip.arrivaltime) - now;
    if (duration_ms < 0 || duration_ms > MAX_MS) continue;

    const key = `${trip.routeno}-${trip.tostationname}`;
    if (!servicesMap.has(key)) {
      servicesMap.set(key, {
        no: trip.routeno,
        destination: trip.tostationname,
        trips: [],
      });
    }

    const location =
      (trip.vehicleid && allVehicles.get(trip.vehicleid)) ||
      (trip.busno && allVehicles.get(trip.busno)) ||
      null;

    servicesMap.get(key).trips.push({
      duration_ms,
      type: 'SD',
      load: trip.devicestatusflag === 1 ? 'SEA' : 'SDA',
      feature: 'WAB',
      visit_number: 1,
      origin_code: trip.fromstationname,
      destination_code: trip.tostationname,
      vehicle_id: trip.vehicleid,
      bus_no: trip.busno,
      location,
    });
  }

  return Array.from(servicesMap.values()).map(({ no, destination, trips }) => {
    trips.sort((a, b) => a.duration_ms - b.duration_ms);
    const service = { no, destination, frequency: trips.length };
    if (trips[0]) service.next = trips[0];
    if (trips[1]) service.next2 = trips[1];
    if (trips[2]) service.next3 = trips[2];
    return service;
  });
}
