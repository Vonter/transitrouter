/**
 * Cloudflare Pages Function for BMTC Stop Vehicles (Phase 2)
 * Fetches vehicle positions for multiple routes at a stop.
 * Endpoint: /api/bmtc/stop-vehicles?routes=KIA-9,335E,500CA
 *
 * Route names are resolved via BLR_ID_MAPPING — a name missing from it is
 * dropped, no fallback. Tries the GTFS-RT feed first per route, matching
 * against Namma BMTC's ids then the legacy numeric BMTC id (so the fast
 * path keeps working if the feed's id scheme ever switches). Falls back to
 * a live Namma BMTC route-live-info call per direction variant, merged.
 * bmtcmobileapi.karnataka.gov.in is retired.
 */
import BLR_ID_MAPPING from './blr-id-mapping.js';
import { fetchVehiclePositions, matchesRouteId } from './bmtc-rt.js';
import { fetchRouteLiveInfo, parseRouteMapping } from './namma-bmtc.js';

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
  const userAgent = request.headers.get('User-Agent');

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

    // Resolve each name to its legacy GTFS-RT id and Namma BMTC variants.
    const gtfsRouteIdToNames = new Map(); // gtfsRtRouteId -> names[]
    const nammaRouteIdToNames = new Map(); // nammaBmtcRouteId -> {sampleStopId, names[]}
    for (const name of routeNames) {
      const { gtfsRtRouteId, nammaBmtcRoutes } = parseRouteMapping(BLR_ID_MAPPING.routes[name], BLR_ID_MAPPING);
      if (gtfsRtRouteId) {
        if (!gtfsRouteIdToNames.has(gtfsRtRouteId)) gtfsRouteIdToNames.set(gtfsRtRouteId, []);
        gtfsRouteIdToNames.get(gtfsRtRouteId).push(name);
      }
      for (const { nammaBmtcRouteId, sampleStopId } of nammaBmtcRoutes) {
        if (!nammaRouteIdToNames.has(nammaBmtcRouteId)) {
          nammaRouteIdToNames.set(nammaBmtcRouteId, { sampleStopId, names: [] });
        }
        nammaRouteIdToNames.get(nammaBmtcRouteId).names.push(name);
      }
    }

    const allVehicles = [];
    const satisfiedNames = new Set();

    if (gtfsRouteIdToNames.size > 0 || nammaRouteIdToNames.size > 0) {
      let gtfsVehicles = [];
      try {
        gtfsVehicles = await fetchVehiclePositions();
      } catch (error) {
        console.error('BMTC GTFS-RT feed fetch failed, using Namma BMTC for all routes:', error);
      }

      // Try Namma BMTC ids against the feed first, then the legacy id —
      // whichever the feed happens to use, this satisfies these names
      // without a live call.
      for (const [nammaBmtcRouteId, { names }] of nammaRouteIdToNames) {
        const matches = gtfsVehicles.filter(
          (v) => matchesRouteId(v, nammaBmtcRouteId) && v.lat != null && v.lng != null,
        );
        if (matches.length === 0) continue;
        matches.forEach((v) => {
          allVehicles.push({
            vehicleId: v.vehicleId,
            vehicleNumber: v.vehicleLabel || v.vehicleId,
            lat: v.lat,
            lng: v.lng,
            heading: v.bearing,
            routeNames: names,
          });
        });
        names.forEach((n) => satisfiedNames.add(n));
      }

      for (const [routeId, names] of gtfsRouteIdToNames) {
        const stillNeeded = names.filter((n) => !satisfiedNames.has(n));
        if (stillNeeded.length === 0) continue;

        const matches = gtfsVehicles.filter(
          (v) => matchesRouteId(v, routeId) && v.lat != null && v.lng != null,
        );
        if (matches.length === 0) continue;
        matches.forEach((v) => {
          allVehicles.push({
            vehicleId: v.vehicleId,
            vehicleNumber: v.vehicleLabel || v.vehicleId,
            lat: v.lat,
            lng: v.lng,
            heading: v.bearing,
            routeNames: stillNeeded,
          });
        });
        stillNeeded.forEach((n) => satisfiedNames.add(n));
      }
    }

    // Routes still needing a live call: those with names GTFS-RT didn't
    // satisfy under either id scheme.
    const nammaBmtcNeeded = new Map();
    for (const [nammaBmtcRouteId, { sampleStopId, names }] of nammaRouteIdToNames) {
      const remaining = names.filter((n) => !satisfiedNames.has(n));
      if (remaining.length > 0) nammaBmtcNeeded.set(nammaBmtcRouteId, { sampleStopId, names: remaining });
    }

    // Fetch vehicle positions from Namma BMTC for all routes still needing it.
    await Promise.all(
      Array.from(nammaBmtcNeeded.entries()).map(async ([nammaBmtcRouteId, { sampleStopId, names }]) => {
        let vehicleMap;
        try {
          vehicleMap = await fetchRouteLiveInfo(nammaBmtcRouteId, sampleStopId, userAgent);
        } catch (error) {
          console.error(`Namma BMTC route-live-info failed for ${nammaBmtcRouteId}:`, error);
          return;
        }
        for (const [vehicleId, parsed] of vehicleMap) {
          if (typeof parsed._latitude !== 'number' || typeof parsed._longitude !== 'number') continue;
          allVehicles.push({
            vehicleId,
            vehicleNumber: parsed.vNo || vehicleId,
            lat: parsed._latitude,
            lng: parsed._longitude,
            heading: parsed.bearing ?? null,
            routeNames: names,
          });
        }
      }),
    );

    // Dedup by vehicleNumber||vehicleId, merging routeNames of duplicates
    // (a vehicle could legitimately surface once per queried route/source).
    const byKey = new Map();
    for (const v of allVehicles) {
      const key = v.vehicleNumber || v.vehicleId;
      if (byKey.has(key)) {
        const existing = byKey.get(key);
        existing.routeNames = Array.from(new Set([...existing.routeNames, ...v.routeNames]));
      } else {
        byKey.set(key, v);
      }
    }

    const cacheHeaders = { 'Cache-Control': 'public, max-age=15' };
    return jsonResponse({ vehicles: Array.from(byKey.values()) }, 200, cacheHeaders);
  } catch (error) {
    console.error('BMTC Stop Vehicles Function Error:', error);
    return jsonResponse(
      { error: 'Failed to fetch vehicle data', message: error.message },
      500,
    );
  }
}
