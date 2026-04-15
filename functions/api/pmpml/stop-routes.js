/**
 * Cloudflare Pages Function for PMPML Live Arrival Data
 * Endpoint: /api/pmpml/arrivals?stationid=41
 */

const PMPML_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0',
  Accept: '*/*',
  'Content-Type': 'application/json',
  'x-api-key': 't',
  'Host': '127.0.0.1',
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
      'https://prod-pmpml-pis.chartr.in/get_buses_eta',
      {
        method: 'POST',
        headers: PMPML_HEADERS,
        body: JSON.stringify({ device_id: '', source: 'stops', stop_id: parseInt(stationId), user_lat: 18.35, user_lon: 73.65 }),
      },
    );
    if (!res.ok) throw new Error(`PMPML API returned ${res.status}`);

    const result = await res.json();
    const cacheHeaders = { 'Cache-Control': 'public, max-age=10' };

    if (!(result.message.toLowerCase() === 'success')) {
      return jsonResponse({ services: [] }, 200, cacheHeaders);
    }

    const services = await convertPMPMLToServices(result.buses);
    return jsonResponse({ services }, 200, cacheHeaders);
  } catch (error) {
    console.error('PMPML API Function Error:', error);
    return jsonResponse(
      { error: 'Failed to fetch arrival data', message: error.message },
      500,
    );
  }
}

async function convertPMPMLToServices(data) {
  const now = new Date();
  const MAX_MS = 90 * 60 * 1000;

  // Resolve unique route IDs for trips that have a GPS vehicle
  const routeLongNames = [];
  for (const route of data) {
    if (route.route_long_name && ! routeLongNames.includes(route.route_long_name)) {
      routeLongNames.push(route.route_long_name);
    }
  }

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

      })
    }
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
