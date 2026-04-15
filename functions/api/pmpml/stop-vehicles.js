/**
 * Cloudflare Pages Function for PMPML Stop Vehicles (Phase 2)
 * Fetches vehicle positions for multiple routes at a stop.
 * Endpoint: /api/pmpml/stop-vehicles?routes=220,50,14RING
 */

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
      const names = [name+'UP', name+'DOWN', name];
      for (const n of names) {
        if (!routeIdToNames.has(n)) {
          routeIdToNames.set(n, []);
        }
        routeIdToNames.get(n).push(name);
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
    console.error('PMPML Stop Vehicles Function Error:', error);
    return jsonResponse(
      { error: 'Failed to fetch vehicle data', message: error.message },
      500,
    );
  }
}

async function fetchVehiclesForRoute(routeLongName) {
  try {
    const res = await fetch(
      'https://prod-pmpml-live-data-api.chartr.in/buses-on-route',
      {
        method: 'POST',
        headers: PMPML_HEADERS,
        body: JSON.stringify({
          route_long_name: routeLongName
        }),
      },
    );

    if (!res.ok) return null;

    const result = await res.json();
    const vehicles = new Map();
    console.log(result);
    for (const v of result.data) {
      if(v.id && !vehicles.has(v.id)) {
        vehicles.set(v.id, {
          vehicleId: v.id,
          vehicleNumber: v.id,
          lat: parseFloat(v.lat),
          lng: parseFloat(v.lon),
          bearing: v.orientation === 0.0 ? null : v.orientation,
        })
      }
    }

    return Array.from(vehicles.values());
  } catch (error) {
    console.error(`Error fetching vehicle data for route ${routeId}:`, error);
    return null;
  }
}
