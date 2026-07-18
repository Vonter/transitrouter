import fetchCache from './fetchCache';

const CACHE_TIME = 10; // minutes — geocode results for a query+bbox are stable short-term

/**
 * Free-text place search via the /api/map/geocode proxy (alpha "locations"
 * feature). Returns [] on any failure so callers can treat it the same as
 * "no live results" without extra error handling.
 *
 * @param {string} query
 * @param {[number,number,number,number]} bbox - [south, west, north, east]
 * @returns {Promise<Array<{name,lat,lon,placeId}>>}
 */
export function fetchGeocode(query, bbox) {
  const params = new URLSearchParams({ q: query });
  if (bbox) params.set('bbox', bbox.join(','));
  const url = `/api/map/geocode?${params.toString()}`;
  return fetchCache(url, CACHE_TIME)
    .then((r) => r.results || [])
    .catch(() => []);
}

/**
 * Reverse-geocode a coordinate to a place name via the /api/map/geocode
 * proxy (alpha "locations" feature). Returns null on any failure so callers
 * can fall back to a coordinate-based label.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<string|null>}
 */
export function fetchReverseGeocode(lat, lon) {
  const url = `/api/map/geocode?lat=${lat}&lon=${lon}`;
  return fetchCache(url, 24 * 60)
    .then((r) => r.name || null)
    .catch(() => null);
}
