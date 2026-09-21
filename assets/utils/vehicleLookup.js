import { getApiUrl, isApiDisabled } from '../city-config.js';
import { LIVE_DATA_MAX_AGE_MS } from './fetchArrivals.js';

const ACTIVE_CACHE_MS = 30 * 1000;
const activeCache = new Map(); // apiPath -> { at, promise }

const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Fetch every vehicle currently active in the source, as
 * [{ vehicleId, vehicleNumber }]. Cached briefly so focusing/typing in the
 * search box doesn't refetch on every keystroke.
 */
export function fetchActiveVehicles(apiPath) {
  if (!apiPath || isApiDisabled()) return Promise.resolve([]);
  const cached = activeCache.get(apiPath);
  if (cached && Date.now() - cached.at < ACTIVE_CACHE_MS) return cached.promise;

  const promise = fetch(getApiUrl(apiPath))
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to fetch active vehicles: ${res.status}`);
      return res.json();
    })
    .then((data) => data?.vehicles || [])
    .catch((error) => {
      console.error('Error fetching active vehicles:', error);
      activeCache.delete(apiPath);
      return [];
    });
  activeCache.set(apiPath, { at: Date.now(), promise });
  return promise;
}

/** Vehicles whose number/id contains the query (ignoring case and punctuation). */
export function filterVehicles(vehicles, query, limit) {
  const q = normalize(query);
  if (!q) return [];
  const out = [];
  for (const v of vehicles) {
    if (normalize(v.vehicleNumber).includes(q) || normalize(v.vehicleId).includes(q)) {
      out.push(v);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Fetch one vehicle's info. Resolves to null when the vehicle is not in the
 * source (404) or the request fails; `notFound` distinguishes the former.
 */
export async function fetchVehicleInfo(apiPath, vehicleId) {
  if (!apiPath || !vehicleId || isApiDisabled()) return { info: null, notFound: false };
  try {
    const res = await fetch(`${getApiUrl(apiPath)}?vehicleid=${encodeURIComponent(vehicleId)}`);
    if (res.status === 404) return { info: null, notFound: true };
    if (!res.ok) throw new Error(`Failed to fetch vehicle: ${res.status}`);
    return { info: await res.json(), notFound: false };
  } catch (error) {
    console.error('Error fetching vehicle info:', error);
    return { info: null, notFound: false };
  }
}

/**
 * Estimated position of a vehicle from its per-stop arrival times alone
 * (used when the source gives no position): interpolates between the last
 * stop it should have reached and the next one. `coordsFor(stopId)` returns
 * [lng, lat] or null. Returns { lat, lng } or null.
 */
export function estimateLocationFromStops(stops, coordsFor, nowMs = Date.now()) {
  const timed = (stops || [])
    .filter((s) => s.arrivalTime != null && coordsFor(s.stopId))
    .sort((a, b) => a.arrivalTime - b.arrivalTime);
  if (!timed.length) return null;
  const nowSec = nowMs / 1000;
  const nextIdx = timed.findIndex((s) => s.arrivalTime >= nowSec);
  if (nextIdx === -1) {
    const [lng, lat] = coordsFor(timed[timed.length - 1].stopId);
    return { lat, lng };
  }
  if (nextIdx === 0) {
    const [lng, lat] = coordsFor(timed[0].stopId);
    return { lat, lng };
  }
  const prev = timed[nextIdx - 1];
  const next = timed[nextIdx];
  const span = next.arrivalTime - prev.arrivalTime;
  const f = span > 0 ? Math.min(1, Math.max(0, (nowSec - prev.arrivalTime) / span)) : 1;
  const [pLng, pLat] = coordsFor(prev.stopId);
  const [nLng, nLat] = coordsFor(next.stopId);
  return { lat: pLat + (nLat - pLat) * f, lng: pLng + (nLng - pLng) * f };
}

export const isVehicleInfoStale = (info) =>
  info?.lastRefreshMs != null && Date.now() - Number(info.lastRefreshMs) > LIVE_DATA_MAX_AGE_MS;
