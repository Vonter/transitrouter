/**
 * Minimal GTFS-Realtime (protobuf) reader, scoped to the handful of
 * VehiclePosition/TripUpdate fields this app needs. Avoids pulling in a
 * full protobuf runtime for a feed this small.
 *
 * Wire format reference: https://gtfs.org/realtime/reference/
 */

const RT_FEED_URL = 'https://rt-bucket.blrtransit.com/rt/feed/rt.pb';

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

/**
 * Fetches and parses the GTFS-RT feed.
 * Returns { vehicles, tripUpdates }:
 *  - vehicles: { vehicleId, vehicleLabel, tripId, routeId, lat, lng, bearing }[]
 *  - tripUpdates: { tripId, routeId, vehicleId, vehicleLabel, stopTimeUpdates }[],
 *    where each stopTimeUpdate is { stopId, arrival: {delay,time}|null, departure: {delay,time}|null }.
 *    Empty today (the feed only publishes VehiclePositions) but read defensively
 *    so arrivals can switch to it automatically once TripUpdates are published.
 */
export async function fetchGtfsRtFeed() {
  const res = await fetch(RT_FEED_URL, {
    headers: { Accept: 'application/x-protobuf, application/octet-stream' },
  });
  if (!res.ok) throw new Error(`GTFS-RT feed returned ${res.status}`);

  const buf = new Uint8Array(await res.arrayBuffer());
  return parseFeedMessage(buf);
}

/**
 * Fetches and parses just the GTFS-RT VehiclePositions feed.
 * Returns an array of { vehicleId, vehicleLabel, tripId, routeId, lat, lng, bearing }.
 */
export async function fetchVehiclePositions() {
  const { vehicles } = await fetchGtfsRtFeed();
  return vehicles;
}

// NOTE: `routeId` here is NOT the public route number (e.g. "220") and NOT
// the route_id from data/pune's static feed (whose route_id happens to
// equal route_short_name). It's an id from a *different* static GTFS feed
// published by the same source as this realtime feed, at
// rt/control/static/gtfs.zip on this host, where each direction of a route
// gets its own route_id. See data/pune/build_pmpml_route_mapping.py, which
// builds pmpml-route-mapping.js (route_short_name -> route_id[]) from that
// feed — use that mapping to translate a public route number into the
// route_id(s) to match here. The only OTHER reliable join key between this
// feed and the PMPML PIS/chartr APIs is `vehicleId` (a vehicle registration
// number, e.g. "MH12TV0332"), which is consistent across both.

/**
 * Whether a GTFS-RT vehicle belongs to one of the given route_ids (as
 * resolved from pmpml-route-mapping.js for a public route number).
 */
export function matchesRouteIds(vehicle, routeIds) {
  return !!vehicle.routeId && routeIds.includes(vehicle.routeId);
}

/**
 * Builds a vehicle_id -> {lat, lng} lookup from GTFS-RT vehicle positions,
 * for enriching vehicles/trips resolved through some other route-aware API.
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
