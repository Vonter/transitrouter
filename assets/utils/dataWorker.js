/**
 * Data worker — runs Fuse search, closest-stop calculation, and between-routes
 * route-finding off the main thread.
 *
 * Protocol: every message is { id, type, payload }
 *           every response is { id, result } or { id, error }
 */

import Fuse from 'fuse.js';
import CheapRuler from 'cheap-ruler';

// ── Worker-local state ────────────────────────────────────────────────────────

/** @type {Array<{number,name,suffix,coordinates,routes}>} */
let stopsArr = [];

/** @type {Object.<string,{number,name,suffix,coordinates,routes}>} */
let stopsIndex = {};

/** @type {Array<{number,name}>} */
let servicesArr = [];

/** Raw services JSON: { [serviceNumber]: { name, [destination]: stop[][] } } */
let servicesData = null;

let fuseServices = null;
let fuseStops = null;

// Match the CheapRuler latitude used on the main thread
const ruler = new CheapRuler(1.3);

const NEARBY_THRESHOLD = 0.0025; // degrees, ~278 m

// ── Pure helpers (no DOM / Map API deps) ─────────────────────────────────────

function euclideanDist(x1, y1, x2, y2) {
  const dx = x2 - x1,
    dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

function parseRouteKey(routeKey) {
  const first = routeKey.indexOf('|');
  const second = routeKey.indexOf('|', first + 1);
  if (first === -1 || second === -1) return null;
  return {
    service: routeKey.slice(0, first),
    destination: routeKey.slice(first + 1, second),
    variantIdx: routeKey.slice(second + 1),
  };
}

// ── Handlers ─────────────────────────────────────────────────────────────────

function handleInit({ stopsArr: s, servicesArr: sa, servicesData: sd }) {
  stopsArr = s;
  servicesArr = sa;
  servicesData = sd;

  stopsIndex = {};
  for (const stop of stopsArr) stopsIndex[stop.number] = stop;

  fuseServices = new Fuse(servicesArr, {
    threshold: 0.3,
    keys: ['number', 'name'],
  });
  fuseStops = new Fuse(stopsArr, {
    threshold: 0.3,
    keys: ['number', 'name'],
  });

  return { ok: true };
}

function handleSearch({ query }) {
  if (!fuseServices || !fuseStops) return { services: [], stops: [] };
  const services = fuseServices.search(query).map((r) => r.item);
  const stops =
    services.length < 100 ? fuseStops.search(query).map((r) => r.item) : [];
  return { services, stops };
}

function handleClosestStops({ lng, lat }) {
  const results = [];
  for (const stop of stopsArr) {
    const dist = ruler.distance([lng, lat], stop.coordinates);
    if (dist <= 5 * 1000) results.push({ ...stop, distance: dist });
  }
  results.sort((a, b) => a.distance - b.distance);
  return { stops: results.slice(0, 25) };
}

/**
 * O(n) scan to find the nearest stop and all stops within NEARBY_THRESHOLD.
 * @param {{number,coordinates}} stop
 * @returns {{ nearest, nearby }}
 */
function findProximityStops(stop) {
  let nearestDist = Infinity,
    nearest = null;
  const nearby = [];
  for (const s of stopsArr) {
    if (s.number === stop.number) continue;
    const d = euclideanDist(...stop.coordinates, ...s.coordinates);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = s;
    }
    if (d <= NEARBY_THRESHOLD) nearby.push(s);
  }
  return { nearest, nearby };
}

function collectCandidateStops(primary, { nearest, nearby }) {
  const candidates = new Map();
  candidates.set(primary.number, { stop: primary, nearby: false });
  if (nearest) candidates.set(nearest.number, { stop: nearest, nearby: true });
  for (const s of nearby) {
    if (!candidates.has(s.number))
      candidates.set(s.number, { stop: s, nearby: true });
  }
  return candidates;
}

function handleBetweenRoutes({ startStopNumber, endStopNumber, availableServices }) {
  const startStop = stopsIndex[startStopNumber];
  const endStop = stopsIndex[endStopNumber];
  if (!startStop || !endStop) return { routes: [], nearestStartStop: null, nearestEndStop: null };

  const availableSet =
    availableServices.length > 0 ? new Set(availableServices) : null;

  const startProximity = findProximityStops(startStop);
  const endProximity = findProximityStops(endStop);
  const startCandidates = collectCandidateStops(startStop, startProximity);
  const endCandidates = collectCandidateStops(endStop, endProximity);

  // Cache trimmed route data per end-stop to avoid recomputing across candidate pairs
  const endStopCache = new Map();
  function getEndStopRouteData(stop) {
    if (endStopCache.has(stop.number)) return endStopCache.get(stop.number);
    const data = [];
    for (const routeKey of stop.routes) {
      const parsed = parseRouteKey(routeKey);
      if (!parsed) continue;
      const fullStops =
        servicesData[parsed.service]?.[parsed.destination]?.[parsed.variantIdx];
      if (!fullStops) continue;
      const endIdx = fullStops.indexOf(stop.number);
      if (endIdx === -1) continue;
      const stops = fullStops.slice(0, endIdx + 1);
      data.push({
        service: parsed.service,
        stops,
        stopsSet: new Set(stops),
        route: routeKey,
      });
    }
    endStopCache.set(stop.number, data);
    return data;
  }

  function findRoutesBetween(start, end, nearbyStart, nearbyEnd, seenKeys) {
    const results = [];
    const endRouteData = getEndStopRouteData(end);

    for (const routeKey of start.routes) {
      const parsed = parseRouteKey(routeKey);
      if (!parsed) continue;

      if (
        availableSet &&
        start.number === startStopNumber &&
        !availableSet.has(parsed.service)
      ) {
        continue;
      }

      const fullStops =
        servicesData[parsed.service]?.[parsed.destination]?.[parsed.variantIdx];
      if (!fullStops) continue;

      const startIdx = fullStops.indexOf(start.number);
      if (startIdx === -1) continue;

      const serviceStops = fullStops.slice(startIdx);
      const serviceStopsSet = new Set(serviceStops);

      if (serviceStopsSet.has(end.number)) {
        const key = `${parsed.service}--${start.number}-${end.number}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          results.push({
            startStop: start,
            startService: parsed.service,
            startRoute: routeKey,
            stopsBetween: [],
            endStop: end,
            _nearbyStart: nearbyStart,
            _nearbyEnd: nearbyEnd,
          });
        }
      } else {
        for (const endRoute of endRouteData) {
          const key = `${parsed.service}-${endRoute.service}-${start.number}-${end.number}`;
          if (seenKeys.has(key)) continue;

          const [smaller, larger] =
            serviceStopsSet.size < endRoute.stopsSet.size
              ? [serviceStopsSet, endRoute.stopsSet]
              : [endRoute.stopsSet, serviceStopsSet];
          const common = [];
          for (const s of smaller) {
            if (larger.has(s) && s !== start.number && s !== end.number)
              common.push(s);
          }
          if (common.length) {
            seenKeys.add(key);
            results.push({
              startStop: start,
              startService: parsed.service,
              startRoute: routeKey,
              stopsBetween: common,
              endRoute: endRoute.route,
              endService: endRoute.service,
              endStop: end,
              _nearbyStart: nearbyStart,
              _nearbyEnd: nearbyEnd,
            });
          }
        }
      }
    }
    return results;
  }

  const seenKeys = new Set();
  const allRoutes = [];
  for (const [, { stop: s, nearby: ns }] of startCandidates) {
    for (const [, { stop: e, nearby: ne }] of endCandidates) {
      allRoutes.push(...findRoutesBetween(s, e, ns, ne, seenKeys));
    }
  }

  return {
    routes: allRoutes,
    nearestStartStop: startProximity.nearest,
    nearestEndStop: endProximity.nearest,
  };
}

// ── Message dispatch ──────────────────────────────────────────────────────────

const handlers = {
  INIT: handleInit,
  SEARCH: handleSearch,
  CLOSEST_STOPS: handleClosestStops,
  BETWEEN_ROUTES: handleBetweenRoutes,
};

self.onmessage = ({ data: { id, type, payload } }) => {
  const handler = handlers[type];
  if (!handler) {
    self.postMessage({ id, error: `Unknown message type: ${type}` });
    return;
  }
  try {
    self.postMessage({ id, result: handler(payload) });
  } catch (e) {
    self.postMessage({ id, error: e.message });
  }
};
