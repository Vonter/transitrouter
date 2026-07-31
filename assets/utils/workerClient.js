/**
 * Promise-based client for dataWorker.js.
 *
 * The worker is created lazily on first use and reused for the lifetime of the
 * page. Each call gets a unique id so concurrent requests resolve independently.
 */

let _worker = null;
const _pending = new Map(); // id → { resolve, reject }
let _idCounter = 0;

function getWorker() {
  if (!_worker) {
    _worker = new Worker(new URL('./dataWorker.js', import.meta.url), {
      type: 'module',
    });
    _worker.onmessage = ({ data: { id, result, error } }) => {
      const task = _pending.get(id);
      if (!task) return;
      _pending.delete(id);
      error ? task.reject(new Error(error)) : task.resolve(result);
    };
    _worker.onerror = (e) => console.error('[dataWorker]', e.message);
  }
  return _worker;
}

function postTask(type, payload) {
  return new Promise((resolve, reject) => {
    const id = ++_idCounter;
    _pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, type, payload });
  });
}

/**
 * Send processed stop/service arrays + raw services JSON to the worker so it
 * can build Fuse indices and answer routing queries.
 *
 * @param {Object} opts
 * @param {Array}  opts.stopsArr      - [{number,name,suffix,coordinates,routes}]
 * @param {Array}  opts.servicesArr   - [{number,name}]
 * @param {Object} opts.servicesData  - Raw services JSON from services.min.json
 * @param {Array}  [opts.poisArr]     - [{id,name,type,lat,lon,color}]
 * @returns {Promise<{ok:true}>}
 */
export function initDataWorker({ stopsArr, servicesArr, servicesData, poisArr }) {
  return postTask('INIT', { stopsArr, servicesArr, servicesData, poisArr });
}

/**
 * Fuzzy-search services, stops, and (alpha) locations.
 * @param {string} query
 * @returns {Promise<{services:Array, stops:Array, locations:Array}>}
 */
export function workerSearch(query) {
  return postTask('SEARCH', { query });
}

/**
 * Find the 25 closest stops to a coordinate.
 * @param {number} lng
 * @param {number} lat
 * @returns {Promise<{stops:Array}>}
 */
export function workerClosestStops(lng, lat) {
  return postTask('CLOSEST_STOPS', { lng, lat });
}

/**
 * Find the nearest stop to a location plus every other stop sharing its
 * Voronoi cell (same physical place, from the city's clusters.min.json).
 * @param {number} lng
 * @param {number} lat
 * @param {Object} [clusters] - { [stopId]: [[siblingStopId, distanceM], ...] }
 * @returns {Promise<{stops:Array}>}
 */
export function workerNearbyStops(lng, lat, clusters) {
  return postTask('NEARBY_STOPS', { lng, lat, clusters });
}

/**
 * Find routes between two stops (proximity expansion + route intersection).
 * Either side can instead be a location: pass its resolved cluster of nearby
 * stop numbers as `startCandidateNumbers`/`endCandidateNumbers` (first entry
 * treated as primary) to search from/to that whole set instead of a single
 * stop's own proximity expansion.
 * @param {string} [startStopNumber]
 * @param {string} [endStopNumber]
 * @param {string[]} availableServices  - Empty array means no live-API filter
 * @param {Object} [opts]
 * @param {string[]} [opts.startCandidateNumbers]
 * @param {string[]} [opts.endCandidateNumbers]
 * @returns {Promise<{routes:Array, nearestStartStop:Object, nearestEndStop:Object}>}
 */
export function workerBetweenRoutes(
  startStopNumber,
  endStopNumber,
  availableServices,
  { startCandidateNumbers, endCandidateNumbers } = {},
) {
  return postTask('BETWEEN_ROUTES', {
    startStopNumber,
    endStopNumber,
    startCandidateNumbers,
    endCandidateNumbers,
    availableServices,
  });
}
