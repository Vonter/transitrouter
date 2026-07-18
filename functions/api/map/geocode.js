/**
 * Cloudflare Pages Function — proxy for free-text place search and reverse
 * geocoding (alpha "locations" feature).
 * Endpoints:
 *   GET /api/map/geocode?q=...&bbox=south,west,north,east   (forward search)
 *   GET /api/map/geocode?lat=...&lon=...                    (reverse lookup)
 *
 * Nominatim's usage policy requires a descriptive User-Agent/Referer and
 * forbids unauthenticated bulk client-side use, so this cannot be called
 * directly from the browser — this function proxies it server-side and
 * edge-caches responses to stay well under Nominatim's ~1 req/sec policy.
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT = 'transitrouter/1.0 (https://github.com/Vonter/transitrouter)';
const CACHE_TTL_SECONDS = 86400;

function jsonResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

// Nominatim's `display_name` is a full postal-style address (road, area,
// locality, state, postcode, country...). We only want "location, city" —
// take the specific place name (or the first, most-specific display_name
// segment as a fallback) plus whichever address field best represents the
// city, and drop everything else (suburb/state/postcode/country).
function formatPlaceName(r) {
  const address = r.address || {};
  const primary = r.name || (r.display_name || '').split(',')[0].trim();
  const city = address.city || address.town || address.village
    || address.municipality || address.county || address.state_district || '';
  if (!city || city === primary) return primary || r.display_name || '';
  return `${primary}, ${city}`;
}

async function handleForwardSearch(url, q) {
  if (q.length < 3) return jsonResponse({ results: [] });

  const bbox = (url.searchParams.get('bbox') || '').split(',').map(Number);
  const nominatimUrl = new URL(NOMINATIM_SEARCH_URL);
  nominatimUrl.searchParams.set('format', 'jsonv2');
  nominatimUrl.searchParams.set('addressdetails', '1');
  nominatimUrl.searchParams.set('q', q);
  nominatimUrl.searchParams.set('limit', '8');
  if (bbox.length === 4 && bbox.every((n) => Number.isFinite(n))) {
    const [south, west, north, east] = bbox;
    nominatimUrl.searchParams.set('viewbox', `${west},${north},${east},${south}`);
    nominatimUrl.searchParams.set('bounded', '1');
  }

  const upstream = await fetch(nominatimUrl.toString(), {
    headers: { 'User-Agent': USER_AGENT, Referer: url.origin },
  });
  if (!upstream.ok) return jsonResponse({ error: 'Upstream geocoder error' }, 502);
  const results = await upstream.json();
  return jsonResponse({
    results: results.map((r) => ({
      name: formatPlaceName(r),
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      placeId: r.place_id,
    })),
  });
}

async function handleReverse(url, lat, lon) {
  const nominatimUrl = new URL(NOMINATIM_REVERSE_URL);
  nominatimUrl.searchParams.set('format', 'jsonv2');
  nominatimUrl.searchParams.set('addressdetails', '1');
  nominatimUrl.searchParams.set('lat', String(lat));
  nominatimUrl.searchParams.set('lon', String(lon));
  nominatimUrl.searchParams.set('zoom', '18');

  const upstream = await fetch(nominatimUrl.toString(), {
    headers: { 'User-Agent': USER_AGENT, Referer: url.origin },
  });
  if (!upstream.ok) return jsonResponse({ error: 'Upstream geocoder error' }, 502);
  const r = await upstream.json();
  if (!r || r.error) return jsonResponse({ name: null });
  return jsonResponse({
    name: formatPlaceName(r),
    placeId: r.place_id,
  });
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const url = new URL(request.url);

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  const q = (url.searchParams.get('q') || '').trim();

  let response;
  try {
    response = Number.isFinite(lat) && Number.isFinite(lon)
      ? await handleReverse(url, lat, lon)
      : await handleForwardSearch(url, q);
  } catch (e) {
    return jsonResponse({ error: 'Geocode request failed' }, 502);
  }

  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
