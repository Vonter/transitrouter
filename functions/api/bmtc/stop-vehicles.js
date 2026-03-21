/**
 * Cloudflare Pages Function for BMTC Stop Vehicles (Phase 2)
 * Fetches vehicle positions for multiple routes at a stop.
 * Endpoint: /api/bmtc/stop-vehicles?routes=KIA-14,335E,500CA
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
    const routesParam = new URL(request.url).searchParams.get('routes');

    if (!routesParam) {
      return jsonResponse({ error: 'routes parameter is required' }, 400);
    }

    const routeNames = routesParam
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);

    if (routeNames.length === 0) {
      return jsonResponse({ vehicles: [] }, 200);
    }

    // Resolve route names to route IDs using the mapping, deduplicate
    const routeIdToNames = new Map();
    for (const name of routeNames) {
      const routeId = BLR_ROUTE_MAPPING[name];
      if (routeId) {
        if (!routeIdToNames.has(routeId)) {
          routeIdToNames.set(routeId, []);
        }
        routeIdToNames.get(routeId).push(name);
      }
    }

    // Fetch vehicle positions for all unique route IDs in parallel
    const allVehicles = [];
    await Promise.all(
      Array.from(routeIdToNames.entries()).map(
        async ([routeId, serviceNames]) => {
          const vehicles = await fetchVehiclesForRoute(routeId);
          if (!vehicles) return;
          vehicles.forEach((v) => {
            allVehicles.push({
              ...v,
              routeNames: serviceNames,
            });
          });
        },
      ),
    );

    const cacheHeaders = { 'Cache-Control': 'public, max-age=15' };
    return jsonResponse({ vehicles: allVehicles }, 200, cacheHeaders);
  } catch (error) {
    console.error('BMTC Stop Vehicles Function Error:', error);
    return jsonResponse(
      { error: 'Failed to fetch vehicle data', message: error.message },
      500,
    );
  }
}

async function fetchVehiclesForRoute(routeId) {
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
    const vehicles = [];
    const seen = new Set();

    for (const dir of [result.up, result.down]) {
      dir?.data?.forEach((station) =>
        station.vehicleDetails?.forEach((v) => {
          if (!v.centerlat || !v.centerlong) return;
          const key = v.vehiclenumber || v.vehicleid;
          if (seen.has(key)) return;
          seen.add(key);

          vehicles.push({
            vehicleId: v.vehicleid,
            vehicleNumber: v.vehiclenumber,
            lat: parseFloat(v.centerlat),
            lng: parseFloat(v.centerlong),
            heading: v.heading || null,
          });
        }),
      );
    }

    return vehicles;
  } catch (error) {
    console.error(`Error fetching vehicles for route ${routeId}:`, error);
    return null;
  }
}
