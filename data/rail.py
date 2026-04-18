#!/usr/bin/env python3
"""
Fetch metro/subway GeoJSON from Organic Maps CDN and generate rail.json.
Optionally augments with commuter/suburban rail from OpenStreetMap via Overpass.

One or more CDN cities can be combined into a single output file (useful when
a metro network spans multiple Organic Maps city slugs).

Line features are passed through as-is. Named station points are re-emitted
with a computed station-color: the stroke color of the nearest line, or
#ff2600 if the station is near lines of more than one color (interchange).

Usage:
    python3 rail.py --cdn-city bangalore --output blr/rail.json
    python3 rail.py --cdn-city hyderabad --output telangana/rail.json
    python3 rail.py --cdn-city cityA cityB --output combined/rail.json
    python3 rail.py --cdn-city chennai --overpass-bbox 12.75,80.0,13.4,80.35 --output chennai/rail.json
    python3 rail.py --cdn-city mumbai  --overpass-bbox 18.85,72.75,19.35,73.20 --output mumbai/rail.json

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
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request

CDN_BASE = 'https://cdn.organicmaps.app/subway'
OVERPASS_API = 'https://overpass-api.de/api/interpreter'
INTERCHANGE_COLOR = '#ff2600'

# Distance threshold in degrees (~300 m). Stations within this distance of a
# line are considered to belong to that line.
THRESHOLD = 0.003

# Colors that are invisible or near-invisible on a light basemap, mapped to
# visible alternatives.
COLOR_SUBSTITUTIONS = {
    '#ffff00': '#FFD700',  # pure yellow → gold
    '#00ffff': '#0097A7',  # pure cyan → teal
    '#7fffd4': '#00897B',  # aquamarine → teal green
}


def fetch_geojson(cdn_city: str) -> dict:
    url = f'{CDN_BASE}/{cdn_city}.geojson'
    print(f'Fetching {url} ...')
    with urllib.request.urlopen(url) as resp:
        return json.loads(resp.read().decode())


def _overpass_query(query: str, retries: int = 3) -> dict:
    data = urllib.parse.urlencode({'data': query}).encode()
    for attempt in range(retries):
        if attempt:
            delay = 15 * attempt
            print(f'  Retrying in {delay}s ...')
            time.sleep(delay)
        req = urllib.request.Request(
            OVERPASS_API, data=data,
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code in (429, 504) and attempt < retries - 1:
                continue
            raise


def fetch_overpass_commuter_rail(bbox: str) -> list:
    """
    Fetch commuter/suburban rail route relations from OSM via Overpass API.
    bbox: 'south,west,north,east'

    Strategy to avoid timeouts:
    1. Fetch relation IDs + tags only (no geometry) — fast
    2. For each relation, fetch its member ways that intersect the bbox — one
       small query per line, much faster than pulling full relation geometry
    3. Fetch named station nodes in the bbox independently

    Returns raw GeoJSON-style features (LineStrings with 'stroke', Points with
    'name') ready to be merged into the main feature list before color assignment.
    """
    # Step 1: relation metadata (tags only, no geometry)
    meta_query = f'''[out:json][timeout:60];
(
  relation["route"="train"]["service"~"commuter|suburban"]({bbox});
  relation["route"="railway"]["service"~"commuter|suburban"]({bbox});
);
out tags;
'''
    print(f'Querying Overpass for commuter/suburban rail routes ({bbox}) ...')
    meta_raw = _overpass_query(meta_query)

    relations = [e for e in meta_raw['elements'] if e['type'] == 'relation']
    print(f'  {len(relations)} commuter rail routes found')

    # Pick a stroke color: first relation with a colour tag, otherwise brown
    # (distinct from metro line colors and visible on both light and dark maps)
    stroke = '#795548'
    for rel in relations:
        tags = rel.get('tags', {})
        c = tags.get('colour') or tags.get('color')
        if c:
            stroke = substitute_color(c if c.startswith('#') else f'#{c}')
            break
    print(f'  stroke: {stroke}')

    features = []

    # Step 2: main railway tracks in bbox (no service tag = exclude sidings/yards)
    ways_query = f'[out:json][timeout:60];way["railway"="rail"][!"service"]({bbox});out geom;'
    print(f'Querying Overpass for railway tracks ({bbox}) ...')
    ways_raw = _overpass_query(ways_query)

    for element in ways_raw['elements']:
        if element['type'] != 'way' or 'geometry' not in element:
            continue
        coords = [[n['lon'], n['lat']] for n in element['geometry']]
        if len(coords) >= 2:
            features.append({
                'type': 'Feature',
                'properties': {'stroke': stroke},
                'geometry': {'type': 'LineString', 'coordinates': coords},
            })

    print(f'  {len(features)} track segments')

    # Step 3: named railway station nodes (exclude subway entrances/metro platforms)
    stops_query = (
        f'[out:json][timeout:60];'
        f'node["railway"~"station|halt"]["name"]["station"!="subway"]({bbox});'
        f'out body;'
    )
    print(f'Querying Overpass for commuter rail stations ({bbox}) ...')
    stops_raw = _overpass_query(stops_query)

    seen_node_ids: set = set()
    stops_count = 0
    for element in stops_raw['elements']:
        if element['type'] != 'node' or element['id'] in seen_node_ids:
            continue
        seen_node_ids.add(element['id'])
        name = element.get('tags', {}).get('name')
        if not name:
            continue
        features.append({
            'type': 'Feature',
            'properties': {'name': name},
            'geometry': {'type': 'Point', 'coordinates': [element['lon'], element['lat']]},
        })
        stops_count += 1

    print(f'  {stops_count} named stations')
    return features


def _segment_distance(px, py, ax, ay, bx, by) -> float:
    """Euclidean distance (degrees) from point P to segment AB."""
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _linestring_distance(px, py, coords) -> float:
    """Minimum distance from point to a LineString."""
    return min(
        _segment_distance(px, py, coords[i][0], coords[i][1],
                          coords[i + 1][0], coords[i + 1][1])
        for i in range(len(coords) - 1)
    )


def substitute_color(color: str) -> str:
    return COLOR_SUBSTITUTIONS.get(color.lower(), color)


def assign_station_colors(features: list) -> list:
    """
    Return a new list of features with:
    - LineString features unchanged (stroke color substituted if needed).
    - Named Point features re-emitted with station-color set to the stroke of
      the nearest line, or INTERCHANGE_COLOR if near lines of multiple colors.
    - Unnamed Point features dropped (not displayed by the UI).
    """
    lines = []
    result = []
    for f in features:
        if f['geometry']['type'] != 'LineString':
            continue
        stroke = f['properties'].get('stroke')
        if not stroke:
            result.append(f)
            continue
        stroke = substitute_color(stroke)
        patched = {**f, 'properties': {**f['properties'], 'stroke': stroke}}
        result.append(patched)
        lines.append((f['geometry']['coordinates'], stroke))

    for feature in features:
        if feature['geometry']['type'] != 'Point':
            continue
        props = feature['properties']
        if not props.get('name'):
            continue  # unnamed stops are not shown in the UI

        px, py = feature['geometry']['coordinates']

        nearby_colors = {
            stroke
            for coords, stroke in lines
            if _linestring_distance(px, py, coords) <= THRESHOLD
        }

        if len(nearby_colors) > 1:
            color = INTERCHANGE_COLOR
        elif len(nearby_colors) == 1:
            color = next(iter(nearby_colors))
        else:
            color = substitute_color(props.get('marker-color', '#797979'))

        station_props = {
            'name': props['name'],
            'station-color': color,
        }
        if len(nearby_colors) > 1:
            station_props['interchange'] = True

        result.append({
            'type': 'Feature',
            'properties': station_props,
            'geometry': feature['geometry'],
        })

    return result


def merge_interchanges(features: list) -> list:
    """
    Merge interchange Point features with the same base name into a single
    station at their centroid. Base name is derived by stripping parenthetical
    suffixes e.g. "(Purple Line)". Non-interchange features pass through unchanged.
    """
    non_interchange = []
    groups = {}

    for f in features:
        if f['geometry']['type'] != 'Point' or not f['properties'].get('interchange'):
            non_interchange.append(f)
            continue
        name = f['properties']['name']
        base_name = re.sub(r'\s*\([^)]*\)', '', name).strip()
        groups.setdefault(base_name, []).append(f['geometry']['coordinates'])

    merged = [
        {
            'type': 'Feature',
            'properties': {
                'name': base_name,
                'station-color': INTERCHANGE_COLOR,
                'interchange': True,
            },
            'geometry': {
                'type': 'Point',
                'coordinates': [
                    sum(c[0] for c in coords) / len(coords),
                    sum(c[1] for c in coords) / len(coords),
                ],
            },
        }
        for base_name, coords in groups.items()
    ]

    return non_interchange + merged


def process(cdn_cities: list, output_file: str, overpass_bbox: str | None) -> None:
    all_features = []
    for cdn_city in cdn_cities:
        raw = fetch_geojson(cdn_city)
        features = raw['features']
        lines = [f for f in features if f['geometry']['type'] == 'LineString']
        points = [f for f in features if f['geometry']['type'] == 'Point']
        named = [f for f in points if f['properties'].get('name')]
        print(f'  {len(lines)} line segments, {len(named)} named stations')
        all_features.extend(features)

    if overpass_bbox:
        all_features.extend(fetch_overpass_commuter_rail(overpass_bbox))

    processed = assign_station_colors(all_features)
    processed = merge_interchanges(processed)

    interchanges = sum(
        1 for f in processed
        if f['geometry']['type'] == 'Point'
        and f['properties'].get('interchange')
    )
    print(f'  {interchanges} interchange stations detected')

    out = {'type': 'FeatureCollection', 'features': processed}
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(out, f, separators=(',', ':'), ensure_ascii=False)
    print(f'Wrote {output_file}')


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Generate rail.json from Organic Maps subway GeoJSON.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split('Examples:')[1],
    )
    parser.add_argument(
        '--cdn-city', required=True, nargs='+',
        help='One or more city slugs for the Organic Maps CDN (e.g. bangalore mumbai)',
    )
    parser.add_argument(
        '--overpass-bbox',
        help='Bounding box for OSM commuter/suburban rail query: south,west,north,east'
             ' (e.g. 12.75,80.0,13.4,80.35 for Chennai)',
    )
    parser.add_argument(
        '--output', required=True,
        help='Output file path (e.g. blr/rail.json)',
    )
    args = parser.parse_args()

    try:
        process(args.cdn_city, args.output, args.overpass_bbox)
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()
