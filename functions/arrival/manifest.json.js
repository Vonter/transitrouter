/**
 * Cloudflare Pages Function — dynamic PWA manifest for a specific bus stop.
 *
 * Query params:
 *   name   - stop name (becomes the PWA name)
 *   code   - stop code
 *   city   - city prefix (e.g. "blr")
 *   dest   - destination filter (optional)
 *   destExact - '1' if dest filter is exact match (optional)
 */
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  const name = url.searchParams.get('name') || 'TransitRouter';
  const code = url.searchParams.get('code') || '';
  const city = url.searchParams.get('city') || '';
  const dest = url.searchParams.get('dest') || '';
  const destExact = url.searchParams.get('destExact') || '';

  // Build a per-stop scope so each stop installs as its own PWA.
  // The `stop` param comes first so the start_url (which has it as a prefix) satisfies scope matching.
  const stopSlug =
    city && code
      ? `${encodeURIComponent(city)}/${encodeURIComponent(code)}`
      : null;
  const scope = stopSlug ? `/arrival/?stop=${stopSlug}` : '/arrival/';

  // Build the start_url that opens directly to this stop's arrivals
  const startParams = [];
  if (stopSlug) startParams.push(`stop=${stopSlug}`);
  if (dest) startParams.push(`dest=${encodeURIComponent(dest)}`);
  if (destExact === '1') startParams.push('destExact=1');
  let startUrl = `/arrival/${startParams.length ? `?${startParams.join('&')}` : ''}`;
  if (city && code) startUrl += `#/${city}/${code}`;
  else if (code) startUrl += `#${code}`;

  const shortName = name.length > 15 ? name.slice(0, 15).trimEnd() + '…' : name;

  const manifest = {
    id: scope,
    name,
    short_name: shortName,
    description: `Live bus arrivals at ${name}`,
    display: 'standalone',
    background_color: '#f7f7f7',
    theme_color: '#f7f7f7',
    scope,
    start_url: startUrl,
    icons: [
      {
        src: '/icons/maskable-icon.png',
        sizes: '196x196',
        type: 'image/png',
        purpose: 'any maskable',
      },
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'no-store',
    },
  });
}
