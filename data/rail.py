#!/usr/bin/env python3
"""
Generate rail.json from Organic Maps CDN subway GeoJSON, optionally augmented
with commuter/suburban rail from OpenStreetMap Overpass.

CDN station colors are assigned by proximity to the nearest line. Commuter rail
interchange status comes from OSM stop_area_group membership, not proximity.

Examples:
    python3 rail.py --cdn-city bangalore    --output blr/rail.json
    python3 rail.py --cdn-city mumbai       --overpass-bbox 18.76,72.75,19.65,73.48  --output mumbai/rail.json
    python3 rail.py --cdn-city delhi        --output delhi/rail.json
    python3 rail.py --cdn-city chennai      --overpass-bbox 12.75,80.0,13.4,80.35    --output chennai/rail.json
    python3 rail.py --cdn-city pune         --output pune/rail.json
    python3 rail.py --cdn-city hyderabad    --overpass-bbox 17.14,78.18,17.65,78.71  --output telangana/rail.json
    python3 rail.py --cdn-city ahmedabad    --output ahmedabad/rail.json
    python3 rail.py --cdn-city kochi        --output kochi/rail.json
    python3 rail.py --cdn-city indore       --output indore/rail.json
"""

import argparse
import gzip
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request

CDN_BASE          = 'https://cdn.organicmaps.app/subway'
OVERPASS_API      = 'https://overpass-api.de/api/interpreter'
INTERCHANGE_COLOR = '#ff2600'
THRESHOLD         = 0.005  # degrees (~500 m) for line proximity

COLOR_SUBSTITUTIONS = {
    '#ffff00': '#FFD700',  # yellow → gold
    '#00ffff': '#0097A7',  # cyan → teal
    '#7fffd4': '#00897B',  # aquamarine → teal green
}

# (word-boundary regex, hex color) matched case-insensitively against CDN line name.
# Applied after color substitution to override specific CDN transit lines.
LINE_COLOR_OVERRIDES = [
    (r'\bMonorail\b', '#56C8D8'),  # Mumbai Monorail: Icy Blue (distinct from Aqua Line)
]

COMMUTER_DEFAULT = '#795548'


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------

def fetch_geojson(cdn_city: str) -> list:
    url = f'{CDN_BASE}/{cdn_city}.geojson'
    print(f'Fetching {url} ...')
    with urllib.request.urlopen(url) as resp:
        return json.loads(resp.read().decode())['features']


def _overpass(query: str, retries: int = 3) -> list:
    data = urllib.parse.urlencode({'data': query}).encode()
    for attempt in range(retries):
        if attempt:
            print(f'  Retrying in {15 * attempt}s ...')
            time.sleep(15 * attempt)
        try:
            req = urllib.request.Request(
                OVERPASS_API, data=data,
                headers={
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': '*/*',
                    'Accept-Encoding': 'gzip, deflate',
                    'User-Agent': 'transitrouter/1.0',
                },
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = resp.read()
                if resp.headers.get('Content-Encoding') == 'gzip':
                    body = gzip.decompress(body)
                return json.loads(body.decode())['elements']
        except urllib.error.HTTPError as e:
            if e.code in (406, 429, 504) and attempt < retries - 1:
                continue
            raise


# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------

def substitute_color(color: str) -> str:
    return COLOR_SUBSTITUTIONS.get(color.lower(), color)


def _route_color(osm_color: str | None) -> str:
    if not osm_color:
        return COMMUTER_DEFAULT
    c = osm_color if osm_color.startswith('#') else f'#{osm_color}'
    return substitute_color(c)


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------

def _dist_to_segment(px, py, ax, ay, bx, by) -> float:
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px-ax)*dx + (py-ay)*dy) / (dx*dx + dy*dy))) if (dx or dy) else 0.0
    return math.hypot(px - ax - t*dx, py - ay - t*dy)


def _dist_to_line(px, py, coords) -> float:
    return min(
        _dist_to_segment(px, py, coords[i][0], coords[i][1], coords[i+1][0], coords[i+1][1])
        for i in range(len(coords) - 1)
    )


def _nearest_line_color(px: float, py: float, lines: list) -> str:
    nearby = {c for coords, c in lines if _dist_to_line(px, py, coords) <= THRESHOLD}
    if len(nearby) == 1:
        return next(iter(nearby))
    if nearby:  # multiple lines within threshold: pick geometrically closest
        return min(lines, key=lambda lc: _dist_to_line(px, py, lc[0]))[1]
    return COMMUTER_DEFAULT


def _cdn_mode(ref: str, name: str) -> str:
    if ref.lower().startswith('mono') or 'monorail' in name.lower():
        return 'monorail'
    return 'metro'


# ---------------------------------------------------------------------------
# Overpass fetchers
# ---------------------------------------------------------------------------

def _fetch_way_colors(bbox: str) -> tuple[dict[int, set[str]], dict[int, str]]:
    """Return (way_colors, stop_colors) from OSM colour-tagged commuter rail route relations.

    way_colors: {way_id: set_of_colors} — used to color track segments by proximity.
    stop_colors: {node_id: color} — used to directly color station nodes that are
    explicit stop members of a colour-tagged route relation.
    """
    elements = _overpass(f'''[out:json][timeout:90];
(relation["route"~"^(train|railway|commuter)$"]({bbox}););
out;''')
    relations = [e for e in elements if e['type'] == 'relation']
    print(f'  {len(relations)} rail route relations found')

    way_colors: dict[int, set[str]] = {}
    stop_colors: dict[int, str] = {}
    matched = 0
    for rel in relations:
        tags = rel.get('tags', {})
        name = tags.get('name', '')
        from_ = tags.get('from', '')
        to = tags.get('to', '')
        service = tags.get('service', '')
        # Skip intercity trains (5-digit train numbers), freight lines, and long-distance routes
        if (re.search(r'\b\d{5}\b', f'{name} {from_} {to}') or
                re.search(r'\bFreight\b|\bGoods\b', name, re.IGNORECASE) or
                re.search(r'long.?distance|freight', service, re.IGNORECASE)):
            continue
        color = _route_color(tags.get('colour') or tags.get('color'))
        if color == COMMUTER_DEFAULT:
            continue  # Skip routes without an OSM colour tag
        matched += 1
        print(f'    {name or "(unnamed)"}: {color}')
        for m in rel.get('members', []):
            if m['type'] == 'way':
                way_colors.setdefault(m['ref'], set()).add(color)
            elif m['type'] == 'node' and m.get('role', '') in (
                'stop', 'stop_entry_only', 'stop_exit_only', 'platform', '',
            ):
                stop_colors.setdefault(m['ref'], color)
    print(f'  {matched} identifiable commuter rail routes')
    return way_colors, stop_colors



def _assemble_way_coords(way_coords_list: list) -> list:
    """Greedily chain OSM way coordinate sequences into one ordered LineString.

    Reverses individual ways as needed so each way's first point connects to
    the previous way's last point.  Gaps (non-connecting consecutive ways) are
    bridged by appending without a link — the dedup/splice logic downstream
    tolerates approximate geometry.
    """
    CONNECT_TOL = 0.001  # ~100 m
    if not way_coords_list:
        return []
    result = list(way_coords_list[0])
    for coords in way_coords_list[1:]:
        if not coords:
            continue
        prev = result[-1]
        if math.hypot(prev[0] - coords[0][0], prev[1] - coords[0][1]) <= CONNECT_TOL:
            result.extend(coords[1:])
        elif math.hypot(prev[0] - coords[-1][0], prev[1] - coords[-1][1]) <= CONNECT_TOL:
            result.extend(list(reversed(coords))[1:])
        else:
            result.extend(coords)  # gap — bridge without a link point
    return result


def _split_at_junction(coords: list, label: str = '') -> list[list]:  # label used only for debug
    """Split assembled paths that loop back or traverse a Y-junction.

    OSM route relations sometimes include track ways for both directions of
    travel, producing a path that either loops back to the origin (classic
    out-and-back) or traverses both arms of a Y-junction through the shared
    stem.  In both cases the shared section would render as double tracks.

    For loops (start ≈ end): trim at the apex (farthest from start).
    For Y-junctions: find the candidate split point T (maximises
    min(dist_to_start, dist_to_end)) and only split if the second half
    actually revisits the first half's geographic area — confirming genuine
    track doubling rather than a simple V-shaped bend in the route.
    """
    if len(coords) < 20:
        return [coords]

    start, end = coords[0], coords[-1]
    d_total = math.hypot(end[0] - start[0], end[1] - start[1])

    if d_total < 0.01:
        # Loop: start ≈ end.  Find apex (max dist from start) and trim there.
        best_val, best_idx = 0, 0
        for i, pt in enumerate(coords):
            d = math.hypot(pt[0] - start[0], pt[1] - start[1])
            if d > best_val:
                best_val, best_idx = d, i
        if best_idx > 5 and best_idx < len(coords) - 5:
            return [coords[: best_idx + 1]]
        return [coords]

    # Y-junction: find point maximising min(dist_to_start, dist_to_end)
    best_val, best_idx = 0, 0
    for i, pt in enumerate(coords):
        val = min(
            math.hypot(pt[0] - start[0], pt[1] - start[1]),
            math.hypot(pt[0] - end[0], pt[1] - end[1]),
        )
        if val > best_val:
            best_val, best_idx = val, i

    ratio = best_val / d_total
    inner = 0.1 < best_idx / len(coords) < 0.9
    if not (ratio > 0.6 and inner):
        return [coords]

    # Verify genuine track doubling: check if the INTERIOR of the second half
    # revisits the interior of the first half.  Sample points well away from
    # the junction so junction-area tracks don't create a false positive.
    # A simple V-shaped bend (Thane→Vashi→Panvel) has no interior overlap;
    # a Y-junction traversal (Panvel→CSMT→Goregaon) backtracks through the stem.
    OVERLAP_PROX = 0.003   # ~300 m — wide enough to catch parallel tracks
    MIN_OVERLAP = 3         # need at least this many sampled overlapping points
    SKIP = 20               # skip this many points near the junction on each side
    pre_junction = coords[: best_idx - SKIP : 5]    # interior of first half
    post_junction = coords[best_idx + SKIP :: 5]    # interior of second half
    if len(pre_junction) < 3 or len(post_junction) < 3:
        return [coords]
    overlap = sum(
        1
        for pt in post_junction
        if any(
            math.hypot(pt[0] - fp[0], pt[1] - fp[1]) < OVERLAP_PROX
            for fp in pre_junction
        )
    )
    if overlap < MIN_OVERLAP:
        return [coords]

    return [coords[: best_idx + 1], coords[best_idx:]]


def _fetch_route_lines(bbox: str) -> tuple[list, set[int], list[dict], dict[int, set[str]]]:
    """Assemble named, colour-tagged OSM route relations into GeoJSON LineStrings.

    Queries all train/railway/commuter route relations that carry a 'colour'
    tag in the bbox (covers any network whose OSM editors have set line
    colours — e.g. Mumbai Suburban Railway, future extensions, new services).
    Each relation's member ways are assembled in order into a LineString with
    'name' and 'stroke' properties so deduplicate_lines can merge slow/fast
    variants and splice branches automatically.

    Returns (features, assembled_way_ids, route_stop_nodes, node_route_colors).
    assembled_way_ids lets _fetch_tracks skip re-drawing those ways.
    node_route_colors maps each stop node ID to the set of distinct line colors
    it appears in — used by _fetch_stations for data-driven interchange detection.
    """
    elements = _overpass(f'''[out:json][timeout:120];
(relation["route"~"^(train|railway|commuter)$"]["colour"]({bbox});)->.rels;
.rels out body;
way(r.rels)["railway"~"^(rail|light_rail|monorail|narrow_gauge|tram)$"];
out body geom;
node(r.rels)["name"];
out body;''')

    relations = [e for e in elements if e['type'] == 'relation']
    way_geom: dict[int, list] = {
        e['id']: [[n['lon'], n['lat']] for n in e['geometry']]
        for e in elements if e['type'] == 'way' and 'geometry' in e
    }
    # Stop-position nodes from all route relations (railway=stop).
    # route_stop_nodes carries full data (id, lon, lat, name) so _fetch_stations
    # can (a) proximity-filter railway=station nodes, and (b) fall back to the
    # stop_position itself for stations that have no railway=station node in OSM.
    all_member_node_ids: set[int] = set()
    for rel in relations:
        all_member_node_ids.update(
            m['ref'] for m in rel.get('members', []) if m['type'] == 'node'
        )
    node_lookup: dict[int, dict] = {
        e['id']: e for e in elements if e['type'] == 'node' and e['id'] in all_member_node_ids
    }
    route_stop_nodes: list[dict] = [
        {'id': e['id'], 'lon': e['lon'], 'lat': e['lat'],
         'name': e.get('tags', {}).get('name', '')}
        for e in node_lookup.values()
    ]
    print(f'  {len(relations)} colour-tagged rail route relations, {len(route_stop_nodes)} stop positions')

    features: list = []
    assembled_way_ids: set[int] = set()
    node_route_colors: dict[int, set[str]] = {}
    matched = 0

    for rel in relations:
        tags = rel.get('tags', {})
        name = tags.get('name', '')
        from_ = tags.get('from', '')
        to = tags.get('to', '')
        service = tags.get('service', '')

        if (re.search(r'\b\d{5}\b', f'{name} {from_} {to}') or
                re.search(r'\bFreight\b|\bGoods\b', name, re.IGNORECASE) or
                re.search(r'long.?distance|freight', service, re.IGNORECASE)):
            continue

        stroke = _route_color(tags.get('colour') or tags.get('color'))
        if stroke == COMMUTER_DEFAULT:
            continue

        member_node_ids = [m['ref'] for m in rel.get('members', []) if m['type'] == 'node']
        for nid in member_node_ids:
            if nid in all_member_node_ids:
                node_route_colors.setdefault(nid, set()).add(stroke)

        member_wids = [m['ref'] for m in rel.get('members', []) if m['type'] == 'way']
        coords = _assemble_way_coords([way_geom[wid] for wid in member_wids if wid in way_geom])
        if len(coords) < 2:
            continue

        features.append({
            'type': 'Feature',
            'properties': {'name': name, 'stroke': stroke},
            'geometry': {'type': 'LineString', 'coordinates': coords},
        })
        assembled_way_ids.update(wid for wid in member_wids if wid in way_geom)
        matched += 1
        print(f'    {name or "(unnamed)"}: {stroke}')

    print(f'  {matched} route lines assembled')
    return features, assembled_way_ids, route_stop_nodes, node_route_colors


def _fetch_tracks(
    bbox: str,
    way_colors: dict[int, set[str]],
    stop_colors: dict[int, str] | None = None,
    exclude_way_ids: set[int] | None = None,
) -> tuple[list, list]:
    """Return (line_features, commuter_lines) for railway tracks in bbox.

    Seeds way colors from stop_colors (station nodes on track ways), then
    flood-fills identified colors to adjacent connected ways, stopping at
    junctions where two different identified colors meet.
    """
    elements = _overpass(
        f'[out:json][timeout:60];way["railway"="rail"][!"service"]({bbox});out body geom;'
    )

    node_to_ways: dict[int, list[int]] = {}
    way_nodes: dict[int, list[int]] = {}
    way_geom: dict[int, list] = {}
    for e in elements:
        if e['type'] != 'way' or 'geometry' not in e:
            continue
        wid = e['id']
        nodes = e.get('nodes', [])
        way_nodes[wid] = nodes
        way_geom[wid] = [[n['lon'], n['lat']] for n in e['geometry']]
        for nid in nodes:
            node_to_ways.setdefault(nid, []).append(wid)

    # Seed: exact node-ID match (station node sits on a track way node)
    if stop_colors:
        for nid, color in stop_colors.items():
            for wid in node_to_ways.get(nid, []):
                way_colors.setdefault(wid, set()).add(color)

    # Flood-fill: propagate colors to adjacent uncolored ways
    changed = True
    while changed:
        changed = False
        for wid in way_nodes:
            if wid in way_colors:
                continue
            adj_colors: set[str] = set()
            for nid in way_nodes[wid]:
                for adj_wid in node_to_ways.get(nid, []):
                    if adj_wid != wid:
                        adj_colors |= way_colors.get(adj_wid, set())
            non_default = adj_colors - {COMMUTER_DEFAULT}
            if len(non_default) == 1:
                way_colors[wid] = non_default
                changed = True

    features: list = []
    commuter_lines: list = []
    for wid, coords in way_geom.items():
        if len(coords) < 2:
            continue
        for color in (way_colors.get(wid) or {COMMUTER_DEFAULT}):
            # Ways already covered by a named route LineString are kept in
            # commuter_lines for station proximity colouring but not rendered
            # again as raw segments (avoids double-drawing).
            if not (exclude_way_ids and wid in exclude_way_ids):
                features.append({
                    'type': 'Feature',
                    'properties': {'stroke': color},
                    'geometry': {'type': 'LineString', 'coordinates': coords},
                })
            if color != COMMUTER_DEFAULT:
                commuter_lines.append((coords, color))
    print(f'  {len(features)} track segments')
    return features, commuter_lines


def _fetch_interchange_nodes(bbox: str, stop_colors: dict[int, str] | None = None) -> set[int]:
    """Return node IDs of stations at genuine multi-line interchanges.

    A stop_area_group is only treated as an interchange if its member stop_areas
    span more than one transit line. Line identity is determined by:
      1. The stop_area's colour/network/operator/ref tags (primary).
      2. The stop node's color in stop_colors, i.e. its identified commuter route
         (secondary, used when no OSM tags distinguish the lines).
    Same-line groups (e.g. fast vs slow platforms for one route) are excluded.
    """
    elements = _overpass(f'''[out:json][timeout:90];
relation["public_transport"="stop_area_group"]({bbox})->.sag;
relation(r.sag)["public_transport"="stop_area"]->.sa;
(.sag; .sa;);
out body;''')

    sag_to_sa: dict[int, set[int]] = {}
    sag_direct_nodes: dict[int, set[int]] = {}
    sa_to_nodes: dict[int, set[int]] = {}
    sa_line_key: dict[int, str | None] = {}

    for e in elements:
        if e['type'] != 'relation':
            continue
        tags = e.get('tags', {})
        members = e.get('members', [])
        eid = e['id']
        pt = tags.get('public_transport')
        if pt == 'stop_area_group':
            sag_to_sa[eid] = {m['ref'] for m in members if m['type'] == 'relation'}
            sag_direct_nodes[eid] = {m['ref'] for m in members if m['type'] == 'node'}
        elif pt == 'stop_area':
            sa_to_nodes[eid] = {m['ref'] for m in members if m['type'] == 'node'}
            # Prefer line-specific tags over broad network tags.
            # Extract parenthetical line name from stop_area name, e.g.
            # "Jogeshwari (Western Line)" → "Western Line". This is more
            # specific than network=Indian Railways which is shared by all lines.
            name = tags.get('name', '')
            paren = re.search(r'\(([^)]+)\)', name)
            # Use colour tag or parenthetical line name (e.g. "Jogeshwari (Western Line)").
            # Do NOT use ref/operator — ref is a station code shared across lines,
            # and operator (e.g. "Western Railway") applies to entire networks.
            key = (tags.get('colour') or tags.get('color') or
                   (paren.group(1) if paren else None))
            sa_line_key[eid] = key

    ids: set[int] = set()
    for sag_id, sa_ids in sag_to_sa.items():
        all_nodes: set[int] = set(sag_direct_nodes.get(sag_id, set()))
        for sa_id in sa_ids:
            all_nodes |= sa_to_nodes.get(sa_id, set())
        if not all_nodes:
            continue

        # Check if all stop_areas share the same line identifier tag
        known_tags = {sa_line_key.get(sid) for sid in sa_ids if sa_line_key.get(sid)}
        if len(known_tags) == 1:
            # All stop_areas have the same colour/network/operator/ref → same line
            continue

        # Fallback: if no distinguishing tags, check identified commuter route colors
        if stop_colors is not None and len(known_tags) == 0:
            route_colors = {stop_colors[n] for n in all_nodes if n in stop_colors}
            all_identified = all(n in stop_colors for n in all_nodes)
            if len(route_colors) == 1 and all_identified:
                # All stop nodes identified as the same commuter route → same line
                continue

        ids |= all_nodes

    print(f'  {len(ids)} nodes in stop_area_groups')
    return ids


def _fetch_stations(
    bbox: str,
    commuter_lines: list,
    interchange_ids: set[int],
    stop_colors: dict[int, str] | None = None,
    route_stop_nodes: list[dict] | None = None,
    node_route_colors: dict[int, set[str]] | None = None,
) -> list:
    """Resolve named stations for commuter rail.

    When route_stop_nodes is provided the function uses those nodes (direct
    named members of colour-tagged route relations) as the authoritative station
    set — no separate Overpass query is needed.  Deduplication by name handles
    multiple route variants (slow/fast) sharing the same stop.  Falls back to a
    bbox railway=station|halt query for cities with no colour-tagged relations.
    """
    # Build name → list[node] index so we can detect interchanges where two lines
    # use different OSM nodes at the same physical station (same name, nearby).
    name_nodes: dict[str, list[dict]] = {}
    if route_stop_nodes:
        for s in route_stop_nodes:
            if s['name']:
                name_nodes.setdefault(s['name'], []).append(s)

    def _is_interchange(nid: int, lon: float, lat: float, name: str) -> bool:
        if nid in interchange_ids:
            return True
        # Primary: node appears in 2+ route relations with distinct colors.
        if node_route_colors:
            colors = node_route_colors.get(nid, set()) - {COMMUTER_DEFAULT}
            if len(colors) > 1:
                return True
        # Secondary: different OSM nodes with same name and different colors
        # within ~300 m (~0.003°) — covers stations where each line has its own node.
        if node_route_colors and name in name_nodes:
            same_name = name_nodes[name]
            if len(same_name) > 1:
                node_colors_here = {
                    c
                    for s in same_name
                    for c in (node_route_colors.get(s['id'], set()) - {COMMUTER_DEFAULT})
                    if math.hypot(s['lon'] - lon, s['lat'] - lat) <= 0.003
                }
                if len(node_colors_here) > 1:
                    return True
        return False

    def _resolve_color(nid: int, lon: float, lat: float, name: str) -> dict:
        if _is_interchange(nid, lon, lat, name):
            return {'name': name, 'station-color': INTERCHANGE_COLOR, 'interchange': True}
        if stop_colors and nid in stop_colors:
            return {'name': name, 'station-color': stop_colors[nid]}
        # Fallback: proximity to line geometry (used when node_route_colors unavailable).
        nearby = {c for coords, c in commuter_lines
                  if _dist_to_line(lon, lat, coords) <= THRESHOLD}
        nearby.discard(COMMUTER_DEFAULT)
        color = next(iter(nearby)) if nearby else COMMUTER_DEFAULT
        return {'name': name, 'station-color': color}

    features = []

    if route_stop_nodes:
        # Primary path: emit named member nodes directly, deduplicated by name.
        seen_names: set[str] = set()
        for s in route_stop_nodes:
            if not s['name'] or s['name'] in seen_names:
                continue
            seen_names.add(s['name'])
            px, py = s['lon'], s['lat']
            features.append({
                'type': 'Feature',
                'properties': _resolve_color(s['id'], px, py, s['name']),
                'geometry': {'type': 'Point', 'coordinates': [px, py]},
            })
    else:
        # Fallback for cities without colour-tagged route relations.
        elements = _overpass(
            f'[out:json][timeout:60];'
            f'node["railway"~"station|halt"]["name"]["station"!="subway"]({bbox});out body;'
        )
        for e in elements:
            name = e.get('tags', {}).get('name')
            if not name:
                continue
            px, py = e['lon'], e['lat']
            features.append({
                'type': 'Feature',
                'properties': _resolve_color(e['id'], px, py, name),
                'geometry': {'type': 'Point', 'coordinates': [px, py]},
            })

    print(f'  {len(features)} named stations')
    return features


def fetch_overpass_commuter_rail(bbox: str) -> list:
    print(f'Querying Overpass for commuter rail ({bbox}) ...')
    # Named route LineStrings (one per service, colour-tagged OSM relations).
    # These go through deduplicate_lines later to merge slow/fast variants and
    # splice branches — the assembled_way_ids are excluded from raw track output.
    route_features, assembled_way_ids, route_stop_nodes, node_route_colors = _fetch_route_lines(bbox)
    way_colors, stop_colors = _fetch_way_colors(bbox)
    _, commuter_lines = _fetch_tracks(bbox, way_colors, stop_colors, assembled_way_ids)
    # Add named route geometries to commuter_lines for station proximity coloring.
    for f in route_features:
        stroke = f['properties'].get('stroke', '')
        if stroke != COMMUTER_DEFAULT:
            commuter_lines.append((f['geometry']['coordinates'], stroke))
    interchange_ids = _fetch_interchange_nodes(bbox, stop_colors)
    return route_features + _fetch_stations(
        bbox, commuter_lines, interchange_ids, stop_colors, route_stop_nodes, node_route_colors,
    )


# ---------------------------------------------------------------------------
# Post-processing
# ---------------------------------------------------------------------------

def deduplicate_lines(features: list) -> list:
    """Deduplicate CDN metro LineStrings using full-path geometry and color.

    Groups same-color named LineStrings, then iteratively applies three rules:

    1. **Reverse-direction pairs** — both endpoints are swapped (a[0] ≈ b[-1]
       AND a[-1] ≈ b[0]): remove the feature with fewer coordinate points.

    2. **Branch/spur pairs** — exactly one endpoint is shared AND 5–90 % of
       the path is geometrically shared (the lines share a common trunk but
       diverge): splice at the junction into one LineString preserving both
       termini.  Lines sharing only a terminal hub with 0 % path overlap (e.g.
       three separate metro lines converging at one station) are left alone.

    3. **Near-subset pairs** — ≥ 90 % of one line lies within ~30 m of the
       other: remove the more-contained line (it adds no new territory).

    Commuter-rail features (no 'name' property) are passed through unchanged.
    """
    PROXIMITY = 0.0003    # ~30 m — point-to-polyline closeness
    ENDPOINT_TOL = 0.002  # ~200 m — station-level endpoint match
    SUBSET_FRAC = 0.80    # one-directional overlap fraction → near-subset
    MIN_SHARED = 0.05     # minimum shared-path fraction needed to attempt a splice

    def _frac_close(ca, cb):
        if len(ca) < 2:
            return 0.0
        return sum(1 for p in ca if _dist_to_line(p[0], p[1], cb) <= PROXIMITY) / len(ca)

    def _ep(p, q):
        return math.hypot(p[0] - q[0], p[1] - q[1]) <= ENDPOINT_TOL

    def _splice_coords(ca, cb, frac_ab, frac_ba):
        """Concatenate ca and cb at their single shared endpoint.

        Guards (returns None if any fail):
        - Exactly one endpoint pair must be close (2 shared = reverse pair / loop).
        - max(frac_ab, frac_ba) >= MIN_SHARED: the lines must share actual path,
          not merely terminate at the same hub (e.g. three separate metro lines
          converging at one station but running completely different corridors).
        - max(frac_ab, frac_ba) < SUBSET_FRAC: if either line is nearly entirely
          inside the other it is a near-subset — let the subset-removal rule
          handle it rather than creating a back-tracking splice.
        - The resulting spliced path must not itself be a Y-junction backtrack
          (i.e. _split_at_junction must not want to re-split it), which would
          indicate two arms of the same junction being incorrectly re-joined.
        """
        ends = (
            _ep(ca[-1], cb[0]),
            _ep(ca[-1], cb[-1]),
            _ep(ca[0],  cb[0]),
            _ep(ca[0],  cb[-1]),
        )
        if sum(ends) != 1:
            return None
        shared = max(frac_ab, frac_ba)
        if shared < MIN_SHARED or shared >= SUBSET_FRAC:
            return None
        if ends[0]:
            candidate = ca + cb[1:]
        elif ends[1]:
            candidate = ca + list(reversed(cb))[1:]
        elif ends[2]:
            candidate = list(reversed(ca)) + cb[1:]
        else:
            candidate = cb + ca[1:]
        # Don't splice if the result is a Y-junction backtrack that _split_at_junction
        # would re-split — that means the two arms cover the same track and should stay
        # separate (or be resolved by near-subset spur extraction instead).
        if len(_split_at_junction(candidate)) > 1:
            return None
        return candidate

    cdn_lines, other = [], []
    for f in features:
        if f['geometry']['type'] == 'LineString' and f['properties'].get('name'):
            cdn_lines.append(f)
        else:
            other.append(f)

    by_color: dict[str, list] = {}
    for f in cdn_lines:
        by_color.setdefault(substitute_color(f['properties'].get('stroke', '')), []).append(f)

    deduped: list = []
    total_removed = total_spliced = 0

    for group in by_color.values():
        active = list(group)

        # Pass 1: remove reverse-direction pairs (endpoint swap)
        changed = True
        while changed:
            changed = False
            for i in range(len(active)):
                for j in range(i + 1, len(active)):
                    ca = active[i]['geometry']['coordinates']
                    cb = active[j]['geometry']['coordinates']
                    if _ep(ca[0], cb[-1]) and _ep(ca[-1], cb[0]):
                        drop = j if len(ca) >= len(cb) else i
                        active.pop(drop)
                        total_removed += 1
                        changed = True
                        break
                if changed:
                    break

        # Pass 2: splice diverging branches, then remove near-subsets (iterative)
        changed = True
        while changed and len(active) > 1:
            changed = False
            for i in range(len(active)):
                for j in range(i + 1, len(active)):
                    ca = active[i]['geometry']['coordinates']
                    cb = active[j]['geometry']['coordinates']
                    frac_ab = _frac_close(ca, cb)
                    frac_ba = _frac_close(cb, ca)

                    sc = _splice_coords(ca, cb, frac_ab, frac_ba)
                    if sc is not None:
                        active[i] = {**active[i], 'geometry': {
                            'type': 'LineString', 'coordinates': sc}}
                        active.pop(j)
                        total_spliced += 1
                        changed = True
                        break

                    if max(frac_ab, frac_ba) >= SUBSET_FRAC:
                        # One line is a near-subset of the other: drop the shorter
                        # one and keep the longer route intact.  A partial service
                        # variant (e.g. Mysuru Road → Pattandur Agrahara) is always
                        # covered by the full-line route (Challaghatta → Whitefield),
                        # so removing it loses no geographic coverage.
                        drop_idx = i if len(ca) <= len(cb) else j
                        active.pop(drop_idx)
                        total_removed += 1
                        changed = True
                        break

                if changed:
                    break

        deduped.extend(active)

    if total_removed:
        print(f'  {total_removed} line(s) removed or trimmed to spur')
    if total_spliced:
        print(f'  {total_spliced} branch pair(s) spliced at shared junction')
    return deduped + other


def _post_dedup_trim(features: list) -> list:
    """Split or trim assembled route LineStrings that loop back or cover Y-junctions.

    Called AFTER deduplicate_lines so that spur extraction (which relies on loop
    trunks having high frac coverage) has already completed.  Loops (e.g. Central
    Line trunk Kalyan→CSMT→Kalyan) are trimmed to their apex; Y-junction paths
    (e.g. Harbour Line Panvel→CSMT→Goregaon) are split into two separate features.
    """
    result = []
    for f in features:
        if f['geometry']['type'] != 'LineString' or not f['properties'].get('name'):
            result.append(f)
            continue
        parts = _split_at_junction(f['geometry']['coordinates'], label=f['properties'].get('name',''))
        if len(parts) == 1:
            if len(parts[0]) != len(f['geometry']['coordinates']):
                result.append({**f, 'geometry': {'type': 'LineString', 'coordinates': parts[0]}})
            else:
                result.append(f)
        else:
            for part in parts:
                result.append({**f, 'geometry': {'type': 'LineString', 'coordinates': part}})
    return result


def assign_station_colors(features: list) -> list:
    """Assign station-color to CDN metro stations; pass commuter stations through."""
    # lines stores (coords, stroke, line_key) where line_key is the CDN ref (if present)
    # or the stroke color (for commuter lines without a ref).  Interchange detection
    # groups nearby lines by line_key so bidirectional variants of the same metro line
    # (same ref, opposite directions) don't falsely count as two distinct lines.
    lines, result = [], []
    for f in features:
        if f['geometry']['type'] != 'LineString':
            continue
        stroke = f['properties'].get('stroke')
        if not stroke:
            result.append(f)
            continue
        stroke = substitute_color(stroke)
        name = f['properties'].get('name', '')
        for pattern, override in LINE_COLOR_OVERRIDES:
            if re.search(pattern, name, re.IGNORECASE):
                stroke = override
                break
        ref = f['properties'].get('ref')
        if ref:
            mode = _cdn_mode(ref, name)
            new_props = {**f['properties'], 'stroke': stroke, 'mode': mode}
        else:
            mode = 'rail'
            new_props = {**f['properties'], 'stroke': stroke, 'mode': mode}
        result.append({**f, 'properties': new_props})
        line_key = ref or stroke  # CDN lines have ref; commuter lines use stroke
        lines.append((f['geometry']['coordinates'], stroke, line_key, mode))

    for f in features:
        if f['geometry']['type'] != 'Point' or not f['properties'].get('name'):
            continue
        props = f['properties']
        if 'station-color' in props:  # commuter rail: already resolved, tag mode
            result.append({**f, 'properties': {**props, 'mode': 'rail'}})
            continue
        px, py = f['geometry']['coordinates']
        # Color assignment: pick the nearest line's stroke and inherit its mode.
        if lines:
            nearest = min(lines, key=lambda lsrm: _dist_to_line(px, py, lsrm[0]))
            color = nearest[1]
            station_mode = nearest[3]
        else:
            color = substitute_color(props.get('marker-color', '#797979'))
            station_mode = 'metro'
        # Interchange detection: trust the CDN pre-mark (marker-color == INTERCHANGE_COLOR)
        # rather than proximity, which produces false positives for parallel lines.
        interchange = substitute_color(props.get('marker-color', '')) == INTERCHANGE_COLOR
        sp = {'name': props['name'], 'station-color': color, 'mode': station_mode}
        if interchange:
            sp['interchange'] = True
        result.append({**f, 'properties': sp})
    return result


def merge_interchanges(features: list) -> list:
    """Merge same-name interchange stations to their centroid."""
    non_ix, groups = [], {}
    for f in features:
        if f['geometry']['type'] != 'Point' or not f['properties'].get('interchange'):
            non_ix.append(f)
            continue
        base = re.sub(r'\s*\([^)]*\)', '', f['properties']['name']).strip()
        props = f['properties']
        entry = groups.setdefault(base, {'pts': [], 'modes': set()})
        entry['pts'].append(f['geometry']['coordinates'])
        if 'mode' in props:
            entry['modes'].add(props['mode'])
    result = []
    for name, data in groups.items():
        pts, modes = data['pts'], data['modes']
        props = {'name': name, 'station-color': INTERCHANGE_COLOR, 'interchange': True}
        # If all members share one mode keep it; mixed modes (e.g. metro+rail) omit mode.
        if len(modes) == 1:
            props['mode'] = next(iter(modes))
        result.append({
            'type': 'Feature',
            'properties': props,
            'geometry': {'type': 'Point', 'coordinates': [
                sum(c[0] for c in pts) / len(pts),
                sum(c[1] for c in pts) / len(pts),
            ]},
        })
    return non_ix + result


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def process(cdn_cities: list, output_file: str, overpass_bbox: str | None) -> None:
    features = []
    for city in cdn_cities:
        raw = fetch_geojson(city)
        lines = sum(1 for f in raw if f['geometry']['type'] == 'LineString')
        named = sum(1 for f in raw if f['geometry']['type'] == 'Point' and f['properties'].get('name'))
        print(f'  {lines} line segments, {named} named stations')
        features.extend(raw)

    if overpass_bbox:
        features.extend(fetch_overpass_commuter_rail(overpass_bbox))

    features = merge_interchanges(assign_station_colors(_post_dedup_trim(deduplicate_lines(features))))

    n_ix = sum(1 for f in features if f['geometry']['type'] == 'Point' and f['properties'].get('interchange'))
    print(f'  {n_ix} interchange stations')

    with open(output_file, 'w', encoding='utf-8') as fh:
        json.dump({'type': 'FeatureCollection', 'features': features}, fh, separators=(',', ':'), ensure_ascii=False)
    print(f'Wrote {output_file}')


def main() -> None:
    p = argparse.ArgumentParser(
        description='Generate rail.json from Organic Maps subway GeoJSON.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split('Examples:')[1],
    )
    p.add_argument('--cdn-city', required=True, nargs='+',
                   help='Organic Maps CDN city slug(s) (e.g. bangalore mumbai)')
    p.add_argument('--overpass-bbox',
                   help='Bounding box for commuter rail: south,west,north,east')
    p.add_argument('--output', required=True, help='Output file path (e.g. blr/rail.json)')
    args = p.parse_args()

    try:
        process(args.cdn_city, args.output, args.overpass_bbox)
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        import traceback; traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()
