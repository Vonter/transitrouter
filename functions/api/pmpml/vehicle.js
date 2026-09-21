/**
 * Cloudflare Pages Function for PMPML GTFS-RT vehicle lookup
 * Endpoint: /api/pmpml/vehicle                     (all active vehicles)
 *           /api/pmpml/vehicle?vehicleid=MH12TV0332 (one vehicle's info)
 * See ../vehicle.js for the response shapes.
 */
import { createVehicleHandler } from '../vehicle.js';
import { fetchGtfsRtFeed } from './pmpml-rt.js';
import ROUTE_MAPPING from './pmpml-route-mapping.js';

// route_id -> public route number (see the caveat in pmpml-rt.js)
const ROUTE_ID_TO_NAME = Object.fromEntries(
  Object.entries(ROUTE_MAPPING).flatMap(([name, ids]) => ids.map((id) => [id, name])),
);

export const onRequest = createVehicleHandler('PMPML', () => fetchGtfsRtFeed(), {
  resolveRouteNo: (routeId) => ROUTE_ID_TO_NAME[routeId],
});
