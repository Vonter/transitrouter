/**
 * Cloudflare Pages Function — approximate visitor location.
 * Endpoint: /api/map/geolocator
 *
 * Reads Cloudflare's edge-populated `request.cf` (city/region/country/
 * lat/lon), already present on every request that hits Pages Functions —
 * no external IP-geolocation lookup needed here. Used by assets/app.js to
 * pick a nearby city on first load when `defaultCity` is "auto", without a
 * navigator.geolocation permission prompt.
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Per-visitor data (derived from their IP) - must never be cached/shared.
      'Cache-Control': 'private, no-store',
      ...CORS_HEADERS,
      ...extra,
    },
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

  const cf = request.cf;
  const latitude = parseFloat(cf?.latitude);
  const longitude = parseFloat(cf?.longitude);
  if (!cf || Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return jsonResponse(null);
  }

  return jsonResponse({
    city: cf.city || null,
    region: cf.region || null,
    country: cf.country || null,
    latitude,
    longitude,
  });
}