/**
 * Promise-based client for raptorWorker.js — mirrors workerClient.js's
 * pattern for the single-city data worker.
 *
 * The worker is created lazily on first use and reused for the lifetime of
 * the page. Each call gets a unique id so concurrent requests resolve
 * independently.
 */

let _worker = null;
const _pending = new Map(); // id → { resolve, reject }
let _idCounter = 0;

// City codes already pushed into the worker's own cache — a city's
// stopsData/servicesData never change after it first loads, so this avoids
// re-cloning them across the postMessage boundary on every search.
const syncedCities = new Set();

function getWorker() {
  if (!_worker) {
    _worker = new Worker(new URL('./raptorWorker.js', import.meta.url), {
      type: 'module',
    });
    _worker.onmessage = ({ data: { id, result, error } }) => {
      const task = _pending.get(id);
      if (!task) return;
      _pending.delete(id);
      error ? task.reject(new Error(error)) : task.resolve(result);
    };
    _worker.onerror = (e) => console.error('[raptorWorker]', e.message);
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
 * Push any not-yet-synced city's routing data into the worker's own cache.
 * @param {Map<string,{stopsData:Object, servicesData:Object, clustersData:Object}>} cityDataMap
 */
export function syncRaptorWorkerCities(cityDataMap) {
  const cities = [];
  for (const [code, data] of cityDataMap) {
    if (syncedCities.has(code)) continue;
    cities.push({
      code,
      stopsData: data.stopsData,
      servicesData: data.servicesData,
      clustersData: data.clustersData,
    });
    syncedCities.add(code);
  }
  if (!cities.length) return Promise.resolve({ ok: true });
  return postTask('SYNC_CITIES', { cities });
}

/**
 * Build the global route index (over the given, already-synced city codes)
 * and run the RAPTOR search, entirely inside the worker. `crossCityClusters`
 * is the small nationwide leftover of genuinely cross-city same-place edges
 * (see globaltransfers.py) — each city's own same-place edges instead come
 * from its already-synced `clustersData`.
 * @returns {Promise<{itineraries: Array, globalIndex: Object}>}
 */
export function searchRaptorWorker({ cityCodes, transfers, crossCityClusters, frequencyIndex, startIds, endIds }) {
  return postTask('SEARCH', { cityCodes, transfers, crossCityClusters, frequencyIndex, startIds, endIds });
}
