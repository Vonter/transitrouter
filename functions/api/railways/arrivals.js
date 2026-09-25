/**
 * Cloudflare Pages Function for Indian Railways Live Arrival Data
 * Endpoint: /api/railways/arrivals?stationid=NDLS
 *
 * ETAs come from this feed's TripUpdates, each trip enriched with its
 * train's live position from the same feed's VehiclePositions (see
 * railways-rt.js) — there's no separate live API to fall back to. A feed
 * outage returns an empty (not error) response, same as an "online but no
 * service due" result.
 */
import { fetchGtfsRtFeed, buildVehicleLocationLookup } from './railways-rt.js';
import { convertTripUpdatesToServices } from './railways-arrivals.js';

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

    const cacheHeaders = { 'Cache-Control': 'public, max-age=10' };

    let feed = { vehicles: [], tripUpdates: [] };
    try {
      feed = await fetchGtfsRtFeed();
    } catch (error) {
      console.error('Indian Railways GTFS-RT feed fetch failed:', error);
      return jsonResponse({ services: [], source: 'gtfs-rt' }, 200, cacheHeaders);
    }

    const vehicleLocations = buildVehicleLocationLookup(feed.vehicles);
    const services = convertTripUpdatesToServices(feed.tripUpdates, stationId, vehicleLocations);
    return jsonResponse({ services, source: 'gtfs-rt' }, 200, cacheHeaders);
  } catch (error) {
    console.error('Indian Railways Arrivals API Function Error:', error);
    return jsonResponse(
      { error: 'Failed to fetch arrival data', message: error.message },
      500,
    );
  }
}
