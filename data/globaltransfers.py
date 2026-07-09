#!/usr/bin/env python3
"""
Precompute a global walkable-transfer graph spanning every processed city.

Reuses `transfers.py`'s Voronoi/KD-tree `compute_transfers` logic, but runs it
once over the union of every city's `stops.min.json` instead of one city at a
time. Stop ids are prefixed with their city code (`f"{city}^{stop_id}"`)
before the merge, since raw stop numbers are not unique across cities.

Running Voronoi/STRtree over the merged point set naturally produces both
intra-city edges (identical to what `transfers.py --city X` would produce)
and genuine cross-city edges wherever two cities' stops happen to be close
together on the ground (e.g. a city bus stop next to a `railways`/`greyhound`
stop) - no special-casing of "which cities are adjacent" is needed, since
MAX_RADIUS_METERS already bounds any edge to real walking distance.

Output: data/all/transfers.min.json -> { "city^stop_id": [["city^neighbor_id", distance_m], ...], ... }
"""

import json
import os
from pathlib import Path
from typing import Dict, List

from transfers import BUFFER_METERS, MAX_RADIUS_METERS, compute_transfers, load_stops

SCRIPT_DIR = Path(__file__).parent
OUTPUT_DIR = SCRIPT_DIR / 'all'
OUTPUT_FILE = OUTPUT_DIR / 'transfers.min.json'


def discover_city_stop_files() -> Dict[str, Path]:
    """Return {city_code: path/to/stops.min.json} for every processed city dir."""
    cities = {}
    for item in sorted(SCRIPT_DIR.iterdir()):
        if not item.is_dir() or item.name.startswith('.') or item.name == 'all':
            continue
        stops_file = item / 'stops.min.json'
        if stops_file.is_file():
            cities[item.name] = stops_file
    return cities


def build_global_stops(city_files: Dict[str, Path]) -> Dict[str, List]:
    """Merge every city's stops.min.json into one dict keyed by 'city^stop_id'."""
    merged: Dict[str, List] = {}
    for city, stops_file in city_files.items():
        stops = load_stops(str(stops_file))
        for stop_id, entry in stops.items():
            merged[f'{city}^{stop_id}'] = entry
    return merged


def main():
    city_files = discover_city_stop_files()
    if not city_files:
        print('Error: no city directories with stops.min.json found')
        return 1

    print(f'Found {len(city_files)} processed cities: {", ".join(sorted(city_files))}')

    print('Merging stops into a global, city-qualified stop set...')
    global_stops = build_global_stops(city_files)
    print(f'Merged {len(global_stops):,} stops globally')

    print(
        'Computing global Voronoi-based transfer graph '
        f'(buffer={BUFFER_METERS}m, cap={MAX_RADIUS_METERS}m)...'
    )
    transfers = compute_transfers(global_stops, BUFFER_METERS, MAX_RADIUS_METERS)

    total_edges = sum(len(v) for v in transfers.values())
    cross_city_edges = sum(
        1
        for stop_id, neighbors in transfers.items()
        for neighbor_id, _ in neighbors
        if stop_id.split('^', 1)[0] != neighbor_id.split('^', 1)[0]
    )
    print(
        f'Computed {total_edges:,} directed transfer edges across '
        f'{len(transfers):,} stops ({cross_city_edges:,} cross-city)'
    )

    OUTPUT_DIR.mkdir(exist_ok=True)
    transfers_sorted = dict(sorted(transfers.items()))
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(transfers_sorted, f, separators=(',', ':'))
    print(f'Wrote: {OUTPUT_FILE}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())