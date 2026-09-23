/**
 * Cloudflare Pages Function for Indian Railways GTFS-RT vehicle lookup
 * Endpoint: /api/railways/vehicle                              (all active vehicles)
 *           /api/railways/vehicle?vehicleid=22470:20260923      (one vehicle's info)
 * See ../vehicle.js for the response shapes.
 *
 * No id-translation is needed here (see railways-rt.js) — the feed's
 * route_id is already the local train number and its stop_id is already
 * the local station code, so the default (identity) resolveRouteNo/
 * mapStopId in createVehicleHandler are used as-is.
 */
import { createVehicleHandler } from '../vehicle.js';
import { fetchGtfsRtFeed } from './railways-rt.js';

export const onRequest = createVehicleHandler('Indian Railways', () => fetchGtfsRtFeed());
