const mapOrNull = (value) => (value ? new Map(Object.entries(value)) : null);

export const EMPTY_OVERRIDES = Object.freeze({
  routes: null,
  stops: null,
  cells: null,
  names: null,
  routeNames: null,
  offsets: null,
  tracks: null,
  branches: null,
  stopIcons: null,
  towards: null,
});

export function encodeOverrides(overrides) {
  const data = {};
  if (overrides.routes?.length) data.r = overrides.routes;
  if (overrides.stops?.length) data.s = overrides.stops;
  if (overrides.cells?.size) data.c = Object.fromEntries(overrides.cells);
  if (overrides.names?.size) data.n = Object.fromEntries(overrides.names);
  if (overrides.routeNames?.size)
    data.rn = Object.fromEntries(overrides.routeNames);
  if (overrides.offsets?.size)
    data.lo = Object.fromEntries(
      [...overrides.offsets].map(([id, [dx, dy]]) => [
        id,
        [Math.round(dx * 10) / 10, Math.round(dy * 10) / 10],
      ]),
    );
  if (overrides.tracks?.size) data.tk = Object.fromEntries(overrides.tracks);
  if (overrides.branches?.size)
    data.br = Object.fromEntries(overrides.branches);
  if (overrides.stopIcons?.size)
    data.si = Object.fromEntries(overrides.stopIcons);
  if (overrides.towards != null) data.tw = overrides.towards;
  if (!Object.keys(data).length) return null;

  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeOverrides(encoded) {
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    return {
      routes: data.r || null,
      stops: data.s || null,
      cells: mapOrNull(data.c),
      names: mapOrNull(data.n),
      routeNames: mapOrNull(data.rn),
      offsets: mapOrNull(data.lo),
      tracks: mapOrNull(data.tk),
      branches: mapOrNull(data.br),
      stopIcons: mapOrNull(data.si),
      towards: Object.prototype.hasOwnProperty.call(data, 'tw')
        ? String(data.tw)
        : null,
    };
  } catch {
    return null;
  }
}

export function updateMap(map, key, value, remove = false) {
  const next = new Map(map);
  if (remove) next.delete(key);
  else next.set(key, value);
  return next;
}

export function removeStopFromEdits(edits, stopId) {
  const belongsToStop = (key) => key.slice(key.indexOf(':') + 1) === stopId;
  return {
    ...edits,
    stops: edits.stops.filter((id) => id !== stopId),
    cells: new Map([...edits.cells].filter(([key]) => !belongsToStop(key))),
    names: updateMap(edits.names, stopId, null, true),
    offsets: updateMap(edits.offsets, stopId, null, true),
    stopIcons: updateMap(edits.stopIcons, stopId, null, true),
  };
}
