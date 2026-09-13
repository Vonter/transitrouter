/**
 * Cloudflare Pages Function for BMTC Stop Vehicles (Phase 2)
 * Fetches vehicle positions for multiple routes at a stop.
 * Endpoint: /api/bmtc/stop-vehicles?routes=KIA-9,335E,500CA
 *
 * Route names are resolved via the static BLR_ID_MAPPING — a route missing
 * from that mapping is dropped, with no live lookup to fall back to. Tries
 * the GTFS-RT feed first for each route's numeric `.gtfsRtRouteId`; when
 * the feed has no vehicles for it right now (this feed only carries a
 * sample of the fleet, so that doesn't mean none are running), falls back
 * to Chalo's route-live-info, queried once per direction variant in
 * `.chaloRoutes` and merged. bmtcmobileapi.karnataka.gov.in is retired.
 */
import BLR_ID_MAPPING from './blr-id-mapping.js';
import { fetchVehiclePositions, matchesRouteId } from './bmtc-rt.js';
import { fetchRouteLiveInfo, parseRouteMapping } from './chalo.js';

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

    // Resolve route names to GTFS-RT ids and Chalo route variants. A name
    // missing from the mapping has no live lookup to fall back to, so it's
    // simply dropped.
    const gtfsRouteIdToNames = new Map(); // gtfsRtRouteId -> names[]
    const chaloRouteIdToNames = new Map(); // chaloRouteId -> {sampleStopId, names[]}
    for (const name of routeNames) {
      const { gtfsRtRouteId, chaloRoutes } = parseRouteMapping(BLR_ID_MAPPING.routes[name], BLR_ID_MAPPING);
      if (gtfsRtRouteId) {
        if (!gtfsRouteIdToNames.has(gtfsRtRouteId)) gtfsRouteIdToNames.set(gtfsRtRouteId, []);
        gtfsRouteIdToNames.get(gtfsRtRouteId).push(name);
      }
      for (const { chaloRouteId, sampleStopId } of chaloRoutes) {
        if (!chaloRouteIdToNames.has(chaloRouteId)) {
          chaloRouteIdToNames.set(chaloRouteId, { sampleStopId, names: [] });
        }
        chaloRouteIdToNames.get(chaloRouteId).names.push(name);
      }
    }

    const allVehicles = [];
    const chaloNeeded = new Map(chaloRouteIdToNames); // routes still needing Chalo

    if (gtfsRouteIdToNames.size > 0) {
      let gtfsVehicles = [];
      try {
        gtfsVehicles = await fetchVehiclePositions();
      } catch (error) {
        console.error('BMTC GTFS-RT feed fetch failed, using Chalo for all routes:', error);
      }

      for (const [routeId, names] of gtfsRouteIdToNames) {
        const matches = gtfsVehicles.filter(
          (v) => matchesRouteId(v, routeId) && v.lat != null && v.lng != null,
        );
        if (matches.length > 0) {
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
          // GTFS-RT already covered these names — don't also query Chalo
          // for whichever of their chalo route variants are still pending.
          for (const name of names) {
            for (const [chaloRouteId, entry] of chaloNeeded) {
              entry.names = entry.names.filter((n) => n !== name);
              if (entry.names.length === 0) chaloNeeded.delete(chaloRouteId);
            }
          }
        }
        // No live GTFS-RT vehicles for this route right now — its Chalo
        // variants (already queued in chaloNeeded) will be queried below.
      }
    }

    // Fetch vehicle positions from Chalo for all routes still needing it.
    await Promise.all(
      Array.from(chaloNeeded.entries()).map(async ([chaloRouteId, { sampleStopId, names }]) => {
        let vehicleMap;
        try {
          vehicleMap = await fetchRouteLiveInfo(chaloRouteId, sampleStopId);
        } catch (error) {
          console.error(`Chalo route-live-info failed for ${chaloRouteId}:`, error);
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
