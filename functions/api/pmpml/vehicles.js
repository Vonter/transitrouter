/**
 * Cloudflare Pages Function for PMPML Live Vehicle Tracking
 * Endpoint: /api/pmpml/vehicles?routetext=220
 */

const PMPML_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0',
  Accept: '*/*',
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
    const url = new URL(request.url);
    const routeText = url.searchParams.get('routetext');

    if (!routeText) {
      return jsonResponse({ error: 'routetext parameter is required' }, 400);
    }

    // Try UP, DOWN, and plain variants of the route long name
    const variants = [routeText + 'UP', routeText + 'DOWN', routeText];
    const seenIds = new Set();
    const allVehicles = [];

    const results = await Promise.all(variants.map(fetchVehiclesForRoute));

    for (const vehicles of results) {
      if (!vehicles) continue;
      for (const v of vehicles) {
        if (!seenIds.has(v.vehicleId)) {
          seenIds.add(v.vehicleId);
          allVehicles.push(v);
        }
      }
    }

    return jsonResponse({ routeText, vehicles: allVehicles }, 200, {
      'Cache-Control': 'public, max-age=15',
    });
  } catch (error) {
    console.error('PMPML Vehicles API Function Error:', error);
    return jsonResponse(
      { error: 'Failed to fetch vehicle tracking data', message: error.message },
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
        body: JSON.stringify({ route_long_name: routeLongName }),
      },
    );

    if (!res.ok) return null;

    const result = await res.json();
    const vehicles = new Map();

    for (const v of result.data) {
      if (v.id && !vehicles.has(v.id)) {
        vehicles.set(v.id, {
          vehicleId: v.id,
          vehicleNumber: v.id,
          location: {
            lat: parseFloat(v.lat),
            lng: parseFloat(v.lon),
          },
          bearing: v.orientation === 0.0 ? null : v.orientation,
        });
      }
    }

    return Array.from(vehicles.values());
  } catch (error) {
    console.error(`Error fetching vehicle data for route ${routeLongName}:`, error);
    return null;
  }
}