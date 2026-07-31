/**
 * Runs the all-mode (cross-city) RAPTOR search off the main thread.
 *
 * `buildGlobalRouteIndex` (O(total stops/routes across every synced city)) and
 * `computeRaptorRoute` (O(rounds × marked stops × routes)) are both
 * synchronous, CPU-bound work — previously run inline on the UI thread for
 * every all-mode "between stops" search (see raptor.js's index caching, which
 * only avoided rebuilding, not the main-thread blocking itself). Moving them
 * here mirrors the existing single-city `dataWorker.js` pattern.
 *
 * `refineWithSchedule` stays on the main thread: it needs `fetchCache`'s
 * localStorage-backed cache, which isn't available inside a Worker, and it's
 * already non-blocking (a handful of awaited network fetches, not a tight
 * synchronous loop) — see `runAllModeBetween` in app.js.
 *
 * Protocol: every message is { id, type, payload }
 *           every response is { id, result } or { id, error }
 */

import { buildGlobalRouteIndex, computeRaptorRoute } from './raptor';

// city code -> { stopsData, servicesData, clustersData } — synced once per
// city (the data never changes after a city first loads), so repeat searches
// don't re-clone it across the postMessage boundary every time.
const cityStore = new Map();

function handleSyncCities({ cities }) {
  for (const { code, stopsData, servicesData, clustersData } of cities) {
    cityStore.set(code, { stopsData, servicesData, clustersData });
  }
  return { ok: true };
}

function handleSearch({ cityCodes, transfers, crossCityClusters, frequencyIndex, startIds, endIds }) {
  const cityDataMap = new Map(
    cityCodes.map((code) => [code, cityStore.get(code)]).filter(([, data]) => data),
  );
  const globalIndex = buildGlobalRouteIndex(cityDataMap, crossCityClusters);
  const { itineraries } = computeRaptorRoute({
    globalIndex,
    transfers,
    clusters: globalIndex.clusters,
    frequencyIndex,
    startIds,
    endIds,
  });
  return { itineraries, globalIndex };
}

const handlers = {
  SYNC_CITIES: handleSyncCities,
  SEARCH: handleSearch,
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
