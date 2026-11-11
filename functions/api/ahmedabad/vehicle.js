/**
 * Cloudflare Pages Function for Ahmedabad GTFS-RT vehicle lookup
 * Endpoint: /api/ahmedabad/vehicle                              (all active vehicles)
 *           /api/ahmedabad/vehicle?vehicleid=J049      (one vehicle's info)
 * See ../vehicle.js for the response shapes.
 *
 * Stop ids are used as-is; route ids are translated to the public route
 * number via ahmedabad-rt.js's id mapping.
 */
import { createVehicleHandler } from '../vehicle.js';
import { fetchGtfsRtFeed, routeNameForId } from './ahmedabad-rt.js';

export const onRequest = createVehicleHandler('Ahmedabad', () => fetchGtfsRtFeed(), {
  resolveRouteNo: routeNameForId,
});
