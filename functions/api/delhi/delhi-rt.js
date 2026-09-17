/**
 * Minimal GTFS-Realtime (protobuf) reader for the Delhi (DTC) VehiclePositions
 * feed, scoped to the handful of fields this app needs. Avoids pulling in a
 * full protobuf runtime for a feed this small.
 *
 * Wire format reference: https://gtfs.org/realtime/reference/
 *
 * Unlike PMPML/BMTC, this feed is served by a third-party dataset host
 * (dts-backend.transportstack.in, an OTD/transportstack deployment) that
 * requires an `x-api-key` header. That key must be supplied by the caller
 * (read from a Cloudflare Pages secret, e.g. `env.DELHI_DTS_API_KEY` —
 * never hardcoded here), and responses are cached at the Cloudflare edge
 * for 60 seconds via `cf.cacheTtl` so repeated requests within that window
 * don't re-hit the upstream API or burn through its rate limit.
 */

const RT_FEED_URL =
  'https://dts-backend.transportstack.in/api/dataset/otd/get-file?agency=delhi-buses&category=realtime_gtfs&filename=VehiclePositions.pb';

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

function parseFeedEntity(reader) {
  let entityId = null;
  let vehicle = null;
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readTag();
    if (fieldNumber === 1 && wireType === 2) {
      entityId = reader.readString(reader.readVarint());
    } else if (fieldNumber === 4 && wireType === 2) {
      vehicle = parseVehiclePosition(reader.subMessage(reader.readVarint()));
    } else {
      reader.skip(wireType);
    }
  }
  return vehicle ? { ...vehicle, vehicleId: vehicle.vehicleId || entityId } : null;
}

function parseFeedMessage(buf) {
  const reader = new Reader(buf);
  const vehicles = [];
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readTag();
    if (fieldNumber === 2 && wireType === 2) {
      const vehicle = parseFeedEntity(reader.subMessage(reader.readVarint()));
      if (vehicle && vehicle.lat != null && vehicle.lng != null) vehicles.push(vehicle);
    } else {
      reader.skip(wireType);
    }
  }
  return vehicles;
}

/**
 * Fetches and parses the Delhi GTFS-RT VehiclePositions feed.
 * `env` is the Cloudflare Pages Function's env bindings, used to read the
 * `DELHI_DTS_API_KEY` secret (set via `wrangler pages secret put`).
 * Returns an array of { vehicleId, vehicleLabel, tripId, routeId, lat, lng, bearing }.
 */
export async function fetchVehiclePositions(env) {
  const apiKey = env?.DELHI_DTS_API_KEY;
  if (!apiKey) {
    throw new Error(
      'DELHI_DTS_API_KEY is not configured (set it with `wrangler pages secret put DELHI_DTS_API_KEY`)',
    );
  }

  const res = await fetch(RT_FEED_URL, {
    headers: {
      'x-api-key': apiKey,
      // dts-backend does strict Accept negotiation and 406s on anything
      // other than */* (confirmed against the live API) — it doesn't
      // recognize application/x-protobuf or application/octet-stream.
      Accept: '*/*',
    },
    // Cache the upstream feed at the Cloudflare edge for 60s so repeated
    // requests within that window don't re-hit the dts-backend API.
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`Delhi GTFS-RT feed returned ${res.status}`);

  const buf = new Uint8Array(await res.arrayBuffer());
  return parseFeedMessage(buf);
}

// This feed's route_id is expected to match the route_id in the static
// GTFS for the same agency (delhi-buses), since both are published
// together by the same OTD/transportstack dataset. See
// data/delhi/build_delhi_route_mapping.py, which builds
// delhi-route-mapping.js (route_short_name -> route_id[]) from that static
// feed — use that mapping to translate a public route number into the
// route_id(s) to match here. This assumption isn't verified end-to-end yet
// (fetching the feed requires an API key not available in this
// environment) — if route filtering looks wrong in practice, check it the
// same way the PMPML mismatch was diagnosed: dump raw vehicle route_ids and
// compare against routes.txt in the static feed.

/**
 * Whether a GTFS-RT vehicle belongs to one of the given route_ids (as
 * resolved from delhi-route-mapping.js for a public route number).
 */
export function matchesRouteIds(vehicle, routeIds) {
  return !!vehicle.routeId && routeIds.includes(vehicle.routeId);
}
