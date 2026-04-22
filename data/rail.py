#!/usr/bin/env python3
"""
Generate rail.json from Organic Maps CDN subway GeoJSON, optionally augmented
with commuter/suburban rail from OpenStreetMap Overpass.

CDN station colors are assigned by proximity to the nearest line. Commuter rail
interchange status comes from OSM stop_area_group membership, not proximity.

Examples:
    python3 rail.py --cdn-city bangalore    --output blr/rail.json
    python3 rail.py --cdn-city mumbai       --overpass-bbox 18.85,72.75,19.35,73.20  --output mumbai/rail.json
    python3 rail.py --cdn-city delhi        --output delhi/rail.json
    python3 rail.py --cdn-city chennai      --overpass-bbox 12.75,80.0,13.4,80.35    --output chennai/rail.json
    python3 rail.py --cdn-city pune         --output pune/rail.json
    python3 rail.py --cdn-city hyderabad    --output telangana/rail.json
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
THRESHOLD         = 0.003  # degrees (~300 m) for line proximity

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

# (word-boundary regex, hex color) matched case-insensitively against OSM route name only.
# Use specific line-name phrases (e.g. "Central Line") to avoid false positives from
# station names like "Chennai Central" or "Mumbai Central" appearing in route names.
COMMUTER_LINE_COLORS = [
    (r'\bCentral\s+(Line|Railway)\b', '#10a038'),  # Mumbai Central Line
    (r'\bHarbour\s+(Line|Railway)\b', '#303888'),  # Mumbai Harbour Line
    (r'\bWestern\s+(Line|Railway)\b', '#e05838'),  # Mumbai Western Line
    (r'\bNorth\b',                    '#1565C0'),  # Chennai Suburban North
    (r'\bWest\b',                     '#C62828'),  # Chennai Suburban West
    (r'\bSouth\b',                    '#2E7D32'),  # Chennai Suburban South
]

# (word-boundary regex, hex color) matched case-insensitively against OSM route name,
# from, AND to tags. Terminal station names unambiguously identify the line even when
# the route relation name omits the line name.
COMMUTER_TERMINAL_COLORS = [
    (r'\bChurchgate\b',                                    '#e05838'),  # Mumbai Western south terminus
    (r'\b(Virar|Dahanu)\b',                                '#e05838'),  # Mumbai Western north termini
    (r'\b(Ambivli|Kasara|Karjat)\b',                       '#10a038'),  # Mumbai Central east termini
    (r'\bUran\b',                                          '#303888'),  # Mumbai Harbour east terminus
    (r'\b(Tiruninravur|Thi?ruvallur|Arakonam|Arakkonam)\b',      '#C62828'),  # Chennai West suburban termini
    (r'\b(Kavaraipettai|Kavaraippettai|Ponneri|Gummidipoondi)\b', '#1565C0'),  # Chennai North suburban termini
    (r'\b(Chengalpattu|Tambaram)\b',                       '#2E7D32'),  # Chennai South suburban termini
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


def _route_color(name: str, osm_color: str | None, from_: str = '', to: str = '') -> str:
    for pattern, color in COMMUTER_LINE_COLORS:
        if re.search(pattern, name, re.IGNORECASE):
            return color
    combined = ' '.join(filter(None, [name, from_, to]))
    for pattern, color in COMMUTER_TERMINAL_COLORS:
        if re.search(pattern, combined, re.IGNORECASE):
            return color
    if osm_color:
        c = osm_color if osm_color.startswith('#') else f'#{osm_color}'
        return substitute_color(c)
    return COMMUTER_DEFAULT


def _station_name_color(name: str) -> str | None:
    """Return a line color for a station identified by its own name, or None."""
    for pattern, color in COMMUTER_TERMINAL_COLORS:
        if re.search(pattern, name, re.IGNORECASE):
            return color
    return None


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


# ---------------------------------------------------------------------------
# Overpass fetchers
# ---------------------------------------------------------------------------

def _fetch_way_colors(bbox: str) -> tuple[dict[int, set[str]], dict[int, str]]:
    """Return (way_colors, stop_colors) from identifiable commuter/suburban rail route relations.

    Fetches all train/railway route relations in the bbox, then filters to only
    those whose name, from, or to tags match a known line pattern. This avoids
    relying on the service tag (which is inconsistently applied) while still
    ignoring unidentifiable intercity/freight routes.

    way_colors: {way_id: set_of_colors} — used to color track segments by proximity.
    stop_colors: {node_id: color} — used to directly color station nodes that are
    explicit stop members of an identified route relation. This handles routes whose
    OSM relations list only stop nodes (no track way members).
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
        color = _route_color(name, tags.get('colour') or tags.get('color'), from_, to)
        if color == COMMUTER_DEFAULT:
            continue  # Skip routes we can't identify by name or terminal
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


def _seed_terminal_stop_colors(
    bbox: str,
    stop_colors: dict[int, str],
    terminal_coords: dict[int, tuple[float, float]] | None = None,
) -> None:
    """Seed stop_colors from terminal station names for lines lacking route relations.

    Queries all named station/halt nodes in the bbox and assigns a line color to
    any node whose name matches COMMUTER_TERMINAL_COLORS but isn't already in
    stop_colors.  These seeded nodes are later used by _fetch_tracks to bootstrap
    way coloring via proximity + flood-fill, so lines with no OSM route relation
    (e.g. Chennai Northern Line) still receive the correct color.

    terminal_coords receives the coordinates of newly seeded nodes so that
    _fetch_tracks can do a proximity-based seed when the station node is not
    geometrically on the track way's node list.
    """
    elements = _overpass(
        f'[out:json][timeout:30];'
        f'node["railway"~"station|halt"]["name"]({bbox});out body;'
    )
    seeded = 0
    for e in elements:
        nid = e['id']
        if nid in stop_colors:
            continue
        name = e.get('tags', {}).get('name', '')
        color = _station_name_color(name)
        if color:
            stop_colors[nid] = color
            if terminal_coords is not None:
                terminal_coords[nid] = (e['lat'], e['lon'])
            seeded += 1
    if seeded:
        print(f'  {seeded} stop(s) seeded from terminal station names')


def _fetch_tracks(
    bbox: str,
    way_colors: dict[int, set[str]],
    stop_colors: dict[int, str] | None = None,
    terminal_coords: dict[int, tuple[float, float]] | None = None,
) -> tuple[list, list]:
    """Return (line_features, commuter_lines) for railway tracks in bbox.

    Uses node IDs to:
      1. Seed way colors from stop_colors (station nodes that lie on track ways).
      2. Proximity-seed from terminal_coords for stations that are near but not
         geometrically on the track centerline (tighter 100 m threshold to avoid
         spilling across adjacent lines at junctions).
      3. Flood-fill identified colors to adjacent connected ways, stopping at
         junctions where two different identified colors meet.

    commuter_lines only contains identified (non-default) segments; default-colored
    ways are excluded so that _nearest_line_color never lets an unidentified brown
    segment shadow a nearby identified colored segment.
    """
    # ~100 m — tighter than THRESHOLD to avoid cross-line spill at junctions
    SEED_PROXIMITY = 0.001

    elements = _overpass(
        f'[out:json][timeout:60];way["railway"="rail"][!"service"]({bbox});out body geom;'
    )

    # Build node-adjacency index and cache per-way data
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
    terminal_seeded_ways: set[int] = set()
    if stop_colors:
        for nid, color in stop_colors.items():
            for wid in node_to_ways.get(nid, []):
                way_colors.setdefault(wid, set()).add(color)
                if terminal_coords and nid in terminal_coords:
                    terminal_seeded_ways.add(wid)

    # Seed: proximity-based (station node is near but offset from the track)
    if terminal_coords and stop_colors:
        for nid, (lat, lon) in terminal_coords.items():
            color = stop_colors[nid]
            for wid, coords in way_geom.items():
                if _dist_to_line(lon, lat, coords) <= SEED_PROXIMITY:
                    way_colors.setdefault(wid, set()).add(color)
                    terminal_seeded_ways.add(wid)

    # Flood-fill Phase 1: propagate only from terminal-seeded ways.
    # Route-relation ways already in way_colors are treated as implicit barriers
    # because they're skipped by the "if wid in way_colors: continue" guard,
    # preventing the route-relation wavefront from racing ahead and claiming
    # track ways that belong to lines with no OSM route relation.
    terminal_reachable = set(terminal_seeded_ways)
    changed = True
    while changed:
        changed = False
        for wid in way_nodes:
            if wid in way_colors:
                continue
            adj_colors: set[str] = set()
            for nid in way_nodes[wid]:
                for adj_wid in node_to_ways.get(nid, []):
                    if adj_wid != wid and adj_wid in terminal_reachable:
                        adj_colors |= way_colors.get(adj_wid, set())
            non_default = adj_colors - {COMMUTER_DEFAULT}
            if len(non_default) == 1:
                way_colors[wid] = non_default
                terminal_reachable.add(wid)
                changed = True

    # Flood-fill Phase 2: propagate from all seeded ways (fills gaps left after
    # Phase 1, e.g. route-relation lines whose ways aren't fully listed in OSM).
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
) -> list:
    """Fetch named railway stations; resolve color and interchange status."""
    elements = _overpass(
        f'[out:json][timeout:60];'
        f'node["railway"~"station|halt"]["name"]["station"!="subway"]({bbox});out body;'
    )
    features = []
    for e in elements:
        name = e.get('tags', {}).get('name')
        if not name:
            continue
        px, py = e['lon'], e['lat']
        if e['id'] in interchange_ids:
            props = {'name': name, 'station-color': INTERCHANGE_COLOR, 'interchange': True}
        elif stop_colors and e['id'] in stop_colors:
            props = {'name': name, 'station-color': stop_colors[e['id']]}
        else:
            color = _nearest_line_color(px, py, commuter_lines)
            if color == COMMUTER_DEFAULT:
                color = _station_name_color(name) or color
            props = {'name': name, 'station-color': color}
        features.append({
            'type': 'Feature',
            'properties': props,
            'geometry': {'type': 'Point', 'coordinates': [px, py]},
        })
    print(f'  {len(features)} named stations')
    return features


def fetch_overpass_commuter_rail(bbox: str) -> list:
    print(f'Querying Overpass for commuter rail ({bbox}) ...')
    way_colors, stop_colors = _fetch_way_colors(bbox)
    terminal_coords: dict[int, tuple[float, float]] = {}
    _seed_terminal_stop_colors(bbox, stop_colors, terminal_coords)
    track_features, commuter_lines = _fetch_tracks(bbox, way_colors, stop_colors, terminal_coords)
    interchange_ids = _fetch_interchange_nodes(bbox, stop_colors)
    return track_features + _fetch_stations(bbox, commuter_lines, interchange_ids, stop_colors)


# ---------------------------------------------------------------------------
# Post-processing
# ---------------------------------------------------------------------------

def assign_station_colors(features: list) -> list:
    """Assign station-color to CDN metro stations; pass commuter stations through."""
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
        result.append({**f, 'properties': {**f['properties'], 'stroke': stroke}})
        lines.append((f['geometry']['coordinates'], stroke))

    for f in features:
        if f['geometry']['type'] != 'Point' or not f['properties'].get('name'):
            continue
        props = f['properties']
        if 'station-color' in props:  # commuter rail: already resolved
            result.append(f)
            continue
        px, py = f['geometry']['coordinates']
        nearby = {s for coords, s in lines if _dist_to_line(px, py, coords) <= THRESHOLD}
        if len(nearby) > 1:
            color, interchange = INTERCHANGE_COLOR, True
        elif nearby:
            color, interchange = next(iter(nearby)), False
        else:
            color, interchange = substitute_color(props.get('marker-color', '#797979')), False
        sp = {'name': props['name'], 'station-color': color}
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
        groups.setdefault(base, []).append(f['geometry']['coordinates'])
    return non_ix + [
        {
            'type': 'Feature',
            'properties': {'name': name, 'station-color': INTERCHANGE_COLOR, 'interchange': True},
            'geometry': {'type': 'Point', 'coordinates': [
                sum(c[0] for c in pts) / len(pts),
                sum(c[1] for c in pts) / len(pts),
            ]},
        }
        for name, pts in groups.items()
    ]


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

    features = merge_interchanges(assign_station_colors(features))

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
