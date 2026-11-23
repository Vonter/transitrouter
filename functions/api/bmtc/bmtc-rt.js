/**
 * Minimal GTFS-Realtime (protobuf) reader for the BMTC feed, scoped to the
 * handful of VehiclePosition/TripUpdate fields this app needs. Avoids
 * pulling in a full protobuf runtime for a feed this small.
 *
 * Wire format reference: https://gtfs.org/realtime/reference/
 */

import BLR_ID_MAPPING from './blr-id-mapping.js';
import RECLAIM_ROUTES from './blr-reclaim-routes.js';
import { parseRouteMapping } from './namma-bmtc.js';

const RT_FEED_URL = 'https://gtfs.bengawalk.com/rt/feed/rt.pb';

// Fallback feed (reclaim.city, keyless, CORS-open, regenerated every ~15s).
// Used only when RT_FEED_URL fails or has no vehicles.
const RECLAIM_BASE_URL = 'https://maps.reclaim.city/bengaluru/rt';

class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  eof() {
    return this.pos >= this.end;
  }

  readVarint() {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = this.buf[this.pos++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result >>> 0;
  }

  readTag() {
    const tag = this.readVarint();
    return { fieldNumber: tag >>> 3, wireType: tag & 0x7 };
  }

  readString(len) {
    const str = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return str;
  }

  readFloat() {
    const val = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return val;
  }

  subMessage(len) {
    const sub = new Reader(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return sub;
  }

  skip(wireType) {
    switch (wireType) {
      case 0: // varint
        this.readVarint();
        break;
      case 1: // 64-bit
        this.pos += 8;
        break;
      case 2: { // length-delimited
        const len = this.readVarint();
        this.pos += len;
        break;
      }
      case 5: // 32-bit
        this.pos += 4;
        break;
      default:
        throw new Error(`Unknown protobuf wire type ${wireType}`);
    }
  }
}

function parsePosition(reader) {
  const position = { lat: null, lng: null, bearing: null };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readTag();
    if (fieldNumber === 1 && wireType === 5) position.lat = reader.readFloat();
    else if (fieldNumber === 2 && wireType === 5) position.lng = reader.readFloat();
    else if (fieldNumber === 3 && wireType === 5) position.bearing = reader.readFloat();
    else reader.skip(wireType);
  }
  return position;
}

function parseTripDescriptor(reader) {
  const trip = { tripId: null, routeId: null };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readTag();
    if (fieldNumber === 1 && wireType === 2) trip.tripId = reader.readString(reader.readVarint());
    else if (fieldNumber === 5 && wireType === 2) trip.routeId = reader.readString(reader.readVarint());
    else reader.skip(wireType);
  }
  return trip;
}

function parseVehicleDescriptor(reader) {
  const vehicle = { id: null, label: null };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readTag();
    if (fieldNumber === 1 && wireType === 2) vehicle.id = reader.readString(reader.readVarint());
    else if (fieldNumber === 2 && wireType === 2) vehicle.label = reader.readString(reader.readVarint());
    else reader.skip(wireType);
  }
  return vehicle;
}

function parseVehiclePosition(reader) {
  const vp = {
    tripId: null,
    routeId: null,
    vehicleId: null,
    vehicleLabel: null,
    lat: null,
    lng: null,
    bearing: null,
    timestamp: null,
    occupancyStatus: null,
    occupancyPercentage: null,
  };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readTag();
    if (fieldNumber === 1 && wireType === 2) {
      const trip = parseTripDescriptor(reader.subMessage(reader.readVarint()));
      vp.tripId = trip.tripId;
      vp.routeId = trip.routeId;
    } else if (fieldNumber === 2 && wireType === 2) {
      const position = parsePosition(reader.subMessage(reader.readVarint()));
      vp.lat = position.lat;
      vp.lng = position.lng;
      vp.bearing = position.bearing;
    } else if (fieldNumber === 5 && wireType === 0) {
      vp.timestamp = reader.readVarint(); // unix seconds
    } else if (fieldNumber === 9 && wireType === 0) {
      vp.occupancyStatus = reader.readVarint();
    } else if (fieldNumber === 10 && wireType === 0) {
      vp.occupancyPercentage = reader.readVarint();
    } else if (fieldNumber === 8 && wireType === 2) {
      const vehicle = parseVehicleDescriptor(reader.subMessage(reader.readVarint()));
      vp.vehicleId = vehicle.id;
      vp.vehicleLabel = vehicle.label;
    } else {
      reader.skip(wireType);
    }
  }
  return vp;
}

// Non-zigzag varint reinterpreted as a signed 32-bit int (matches proto2
// `int32`/`sint32`-as-plain-varint fields like StopTimeEvent.delay).
function toSigned32(value) {
  return value | 0;
}

function parseStopTimeEvent(reader) {
  const event = { delay: null, time: null };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readTag();
    if (fieldNumber === 1 && wireType === 0) event.delay = toSigned32(reader.readVarint());
    else if (fieldNumber === 2 && wireType === 0) event.time = reader.readVarint();
    else reader.skip(wireType);
  }
  return event;
}

function parseStopTimeUpdate(reader) {
  const update = { stopId: null, arrival: null, departure: null };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readTag();
    if (fieldNumber === 2 && wireType === 2) {
      update.arrival = parseStopTimeEvent(reader.subMessage(reader.readVarint()));
    } else if (fieldNumber === 3 && wireType === 2) {
      update.departure = parseStopTimeEvent(reader.subMessage(reader.readVarint()));
    } else if (fieldNumber === 4 && wireType === 2) {
      update.stopId = reader.readString(reader.readVarint());
    } else {
      reader.skip(wireType);
    }
  }
  return update;
}

function parseTripUpdate(reader) {
  const tu = {
    tripId: null,
    routeId: null,
    vehicleId: null,
    vehicleLabel: null,
    stopTimeUpdates: [],
  };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readTag();
    if (fieldNumber === 1 && wireType === 2) {
      const trip = parseTripDescriptor(reader.subMessage(reader.readVarint()));
      tu.tripId = trip.tripId;
      tu.routeId = trip.routeId;
    } else if (fieldNumber === 2 && wireType === 2) {
      tu.stopTimeUpdates.push(parseStopTimeUpdate(reader.subMessage(reader.readVarint())));
    } else if (fieldNumber === 3 && wireType === 2) {
      const vehicle = parseVehicleDescriptor(reader.subMessage(reader.readVarint()));
      tu.vehicleId = vehicle.id;
      tu.vehicleLabel = vehicle.label;
    } else {
      reader.skip(wireType);
    }
  }
  return tu;
}

function parseFeedEntity(reader) {
  let entityId = null;
  let vehicle = null;
  let tripUpdate = null;
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readTag();
    if (fieldNumber === 1 && wireType === 2) {
      entityId = reader.readString(reader.readVarint());
    } else if (fieldNumber === 3 && wireType === 2) {
      tripUpdate = parseTripUpdate(reader.subMessage(reader.readVarint()));
    } else if (fieldNumber === 4 && wireType === 2) {
      vehicle = parseVehiclePosition(reader.subMessage(reader.readVarint()));
    } else {
      reader.skip(wireType);
    }
  }
  return {
    vehicle: vehicle ? { ...vehicle, vehicleId: vehicle.vehicleId || entityId } : null,
    tripUpdate,
  };
}

function parseFeedMessage(buf) {
  const reader = new Reader(buf);
  const vehicles = [];
  const tripUpdates = [];
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readTag();
    if (fieldNumber === 2 && wireType === 2) {
      const { vehicle, tripUpdate } = parseFeedEntity(reader.subMessage(reader.readVarint()));
      if (vehicle && vehicle.lat != null && vehicle.lng != null) vehicles.push(vehicle);
      if (tripUpdate && tripUpdate.stopTimeUpdates.length > 0) tripUpdates.push(tripUpdate);
    } else {
      reader.skip(wireType);
    }
  }
  return { vehicles, tripUpdates };
}

async function fetchPrimaryFeed() {
  const res = await fetch(RT_FEED_URL, {
    headers: { Accept: 'application/x-protobuf, application/octet-stream' },
  });
  if (!res.ok) throw new Error(`BMTC GTFS-RT feed returned ${res.status}`);

  const buf = new Uint8Array(await res.arrayBuffer());
  return parseFeedMessage(buf);
}

// Reclaim's route_id is "BMTC:<hash>". blr-reclaim-routes.js (generated from
// Reclaim's static feed by scripts/refresh_blr_rt_mappings.py) gives its route
// name, which blr-id-mapping.js resolves to the legacy gtfsRtRouteId the
// primary feed uses, so every consumer (vehicles.js, stop-vehicles.js,
// vehicle.js) matches it unchanged. Unknown hashes are kept as-is.
const gtfsRtRouteIdByReclaimId = new Map();
function resolveReclaimRouteId(reclaimRouteId) {
  if (!reclaimRouteId) return null;
  if (!gtfsRtRouteIdByReclaimId.has(reclaimRouteId)) {
    const name = RECLAIM_ROUTES[reclaimRouteId];
    const { gtfsRtRouteId } = parseRouteMapping(BLR_ID_MAPPING.routes[name], BLR_ID_MAPPING);
    gtfsRtRouteIdByReclaimId.set(reclaimRouteId, gtfsRtRouteId || reclaimRouteId);
  }
  return gtfsRtRouteIdByReclaimId.get(reclaimRouteId);
}

const toNumber = (v) => (v == null ? null : Number(v));

async function fetchReclaimJson(file) {
  const res = await fetch(`${RECLAIM_BASE_URL}/${file}`, {
    headers: { Accept: 'application/json' },
    cf: { cacheTtl: 10, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`Reclaim BMTC ${file} returned ${res.status}`);
  return res.json();
}

async function fetchReclaimFeed() {
  const [vp, tu] = await Promise.all([
    fetchReclaimJson('vehicle_positions.json'),
    fetchReclaimJson('trip_updates.json'),
  ]);

  const vehicles = [];
  for (const entity of vp.entity || []) {
    const v = entity.vehicle;
    const pos = v?.position;
    if (!pos || pos.latitude == null || pos.longitude == null) continue;
    vehicles.push({
      tripId: v.trip?.tripId ?? null,
      routeId: resolveReclaimRouteId(v.trip?.routeId),
      vehicleId: v.vehicle?.id || entity.id,
      vehicleLabel: v.vehicle?.label ?? null,
      lat: pos.latitude,
      lng: pos.longitude,
      bearing: pos.bearing ?? null,
      timestamp: toNumber(v.timestamp),
      occupancyStatus: null,
      occupancyPercentage: null,
    });
  }

  const tripUpdates = [];
  for (const entity of tu.entity || []) {
    const t = entity.tripUpdate;
    if (!t?.stopTimeUpdate?.length) continue;
    // Entity ids are "tu-<vehicle id>"; the feed has no vehicle descriptor.
    const vehicleId = entity.id?.replace(/^tu-/, '') || null;
    tripUpdates.push({
      tripId: t.trip?.tripId ?? null,
      routeId: resolveReclaimRouteId(t.trip?.routeId),
      vehicleId,
      vehicleLabel: vehicleId,
      stopTimeUpdates: t.stopTimeUpdate.map((u) => ({
        stopId: u.stopId ?? null,
        arrival: u.arrival
          ? { delay: u.arrival.delay ?? null, time: toNumber(u.arrival.time) }
          : null,
        departure: u.departure
          ? { delay: u.departure.delay ?? null, time: toNumber(u.departure.time) }
          : null,
      })),
    });
  }
  return { vehicles, tripUpdates };
}

/**
 * Fetches and parses the BMTC GTFS-RT feed, falling back to reclaim.city's
 * Bengaluru feed when ours errors or has no vehicles.
 * Returns { vehicles, tripUpdates, source }:
 *  - source: 'primary' | 'reclaim'
 *  - vehicles: { vehicleId, vehicleLabel, tripId, routeId, lat, lng, bearing }[]
 *  - tripUpdates: { tripId, routeId, vehicleId, vehicleLabel, stopTimeUpdates }[],
 *    where each stopTimeUpdate is { stopId, arrival: {delay,time}|null, departure: {delay,time}|null }.
 *    This feed DOES publish TripUpdates (unlike PMPML's), but arrivals.js
 *    intentionally still sources ETAs from the BMTC mobile API for now —
 *    switching over is a deliberate future change, not something to wire up
 *    opportunistically here.
 * Reclaim vehicles carry the primary feed's route ids (translated) and
 * Namma BMTC stop ids, so callers need no source-specific handling.
 * Throws only when the primary feed errored and the fallback failed too.
 */
export async function fetchGtfsRtFeed() {
  let primary = null;
  let primaryError = null;
  try {
    primary = await fetchPrimaryFeed();
    if (primary.vehicles.length > 0) {
      console.log(`BMTC realtime source: primary (${primary.vehicles.length} vehicles)`);
      return { ...primary, source: 'primary' };
    }
  } catch (error) {
    primaryError = error;
  }

  try {
    const reclaim = await fetchReclaimFeed();
    if (reclaim.vehicles.length > 0 || !primary) {
      console.log(
        `BMTC realtime source: reclaim fallback (${reclaim.vehicles.length} vehicles; primary ${primaryError ? `failed: ${primaryError.message}` : 'empty'})`,
      );
      return { ...reclaim, source: 'reclaim' };
    }
  } catch (error) {
    console.error('Reclaim BMTC fallback failed:', error);
  }

  if (primary) {
    console.log('BMTC realtime source: primary (empty; reclaim fallback also empty or failed)');
    return { ...primary, source: 'primary' };
  }
  console.log('BMTC realtime source: none (primary failed, reclaim fallback failed)');
  throw primaryError;
}

/**
 * Fetches and parses just the BMTC GTFS-RT VehiclePositions feed.
 * Returns an array of { vehicleId, vehicleLabel, tripId, routeId, lat, lng, bearing, timestamp }.
 * `timestamp` is unix seconds, or null if the feed didn't set it.
 */
export async function fetchVehiclePositions() {
  const { vehicles } = await fetchGtfsRtFeed();
  return vehicles;
}

// This feed's route_id is confirmed to be BMTC's own internal route id,
// e.g. route "KIA-9" has route_id "1101" here — the same value stored as
// `gtfsRtRouteId` per route name in blr-id-mapping.js (functions/api/bmtc,
// generated by scripts/build_blr_id_mapping.py). vehicles.js/stop-vehicles.js
// try this feed first (when that numeric id is known) and fall back to
// Namma BMTC's route-live-info otherwise (see namma-bmtc.js), since this
// feed only carries a small sample of the fleet at any moment — a route
// having no vehicles here doesn't mean Namma BMTC won't have any.

/**
 * Whether a GTFS-RT vehicle belongs to the given route_id (as resolved
 * from blr-id-mapping.js's `gtfsRtRouteId` for a route name, or passed
 * straight through for a routeid query param).
 */
export function matchesRouteId(vehicle, routeId) {
  return !!vehicle.routeId && vehicle.routeId === String(routeId);
}

/**
 * Builds a vehicle_id -> {lat, lng, bearing} lookup from GTFS-RT vehicle
 * positions, for enriching vehicles/trips resolved through the BMTC API
 * (which uses the same vehicleid/vehiclenumber values).
 */
export function buildVehicleLocationLookup(vehicles) {
  const byId = new Map();
  for (const v of vehicles) {
    if (v.lat == null || v.lng == null) continue;
    const loc = { lat: v.lat, lng: v.lng, bearing: v.bearing || null };
    if (v.vehicleId && !byId.has(v.vehicleId)) byId.set(v.vehicleId, loc);
    if (v.vehicleLabel && !byId.has(v.vehicleLabel)) byId.set(v.vehicleLabel, loc);
  }
  return byId;
}
