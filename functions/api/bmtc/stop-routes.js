/**
 * Cloudflare Pages Function for BMTC Stop Routes (Phase 1)
 * Returns arrival ETAs without vehicle positions for fast initial render.
 * Endpoint: /api/bmtc/stop-routes?stationid=20820
 */

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

// Parse "DD-MM-YYYY HH:MM:SS" (IST) to a Date
function parseBMTCDate(dateString) {
  const [date, time = '00:00:00'] = dateString.split(' ');
  const [dd, mm, yyyy] = date.split('-');
  return new Date(`${yyyy}-${mm}-${dd}T${time}+05:30`);
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

    const services = convertBMTCToServices(result.data);
    return jsonResponse({ services }, 200, cacheHeaders);
  } catch (error) {
    console.error('BMTC Stop Routes Function Error:', error);
    return jsonResponse(
      { error: 'Failed to fetch stop routes', message: error.message },
      500,
    );
  }
}

function convertBMTCToServices(data) {
  const now = new Date();
  const MAX_MS = 90 * 60 * 1000;

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
