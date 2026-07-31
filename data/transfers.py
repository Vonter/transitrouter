#!/usr/bin/env python3
"""
Precompute walkable-transfer neighbors between stops from stops.min.json.

Stops within BUFFER_METERS of each other are first clustered together
(single-link, via a KD-tree) and treated as one Voronoi seed at their
centroid - real-world stations often have several stop IDs a few meters
apart, and running Voronoi on each of those individually would just produce
degenerate, near-zero-area cells around each other. Every stop in a cluster
still keeps its own ID; edges are fanned back out to every actual stop pair.

Each cluster's Voronoi cell (relative to every other cluster in the city) is
then buffered outward by BUFFER_METERS so neighboring cells overlap slightly,
then capped to a circle of MAX_RADIUS_METERS around its own centroid so it
never claims a "walkable" area larger than that regardless of how sparse the
surrounding stops are. Two stops are recorded as transfer neighbors if:
  - they're in the same proximity cluster, or
  - their clusters' capped, buffered cells overlap
and, in both cases, the stops themselves are within MAX_RADIUS_METERS of
each other.

Output: {city}/transfers.min.json -> { stop_id: [[neighbor_stop_id, distance_m], ...], ... }
"""

import argparse
import json
import math
import os
from itertools import combinations
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
from scipy.spatial import Voronoi, QhullError, cKDTree
from shapely.geometry import Point, Polygon
from shapely.strtree import STRtree

BUFFER_METERS = 400
MAX_RADIUS_METERS = 1000
EARTH_RADIUS_M = 6371000.0


def load_stops(stops_file: str) -> Dict[str, List]:
    """Load stop_id -> [lon, lat, name, suffix, parentStopID] from stops.min.json."""
    with open(stops_file, 'r', encoding='utf-8') as f:
        return json.load(f)


def project_to_meters(lons: List[float], lats: List[float]) -> Tuple[List[float], List[float]]:
    """Equirectangular projection centered on the stop centroid. Adequate at city scale."""
    lon0 = sum(lons) / len(lons)
    lat0 = sum(lats) / len(lats)
    lat0_rad = math.radians(lat0)
    m_per_deg_lat = math.radians(1) * EARTH_RADIUS_M
    m_per_deg_lon = math.radians(1) * EARTH_RADIUS_M * math.cos(lat0_rad)
    xs = [(lon - lon0) * m_per_deg_lon for lon in lons]
    ys = [(lat - lat0) * m_per_deg_lat for lat in lats]
    return xs, ys


def cluster_by_proximity(coords: np.ndarray, threshold: float) -> np.ndarray:
    """Single-link cluster points within `threshold` of each other via a
    KD-tree. Returns an array mapping each point index to a cluster label."""
    n = len(coords)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    if n > 1 and threshold > 0:
        tree = cKDTree(coords)
        for a, b in tree.query_pairs(r=threshold):
            union(a, b)

    return np.array([find(i) for i in range(n)])


def half_plane_polygon(midpoint: np.ndarray, normal: np.ndarray, reach: float) -> Polygon:
    """Rectangle covering the side of the perpendicular bisector at `midpoint`
    (normal to `normal`) that does NOT point toward `normal` - i.e. the side
    containing the seed point. Sized generously so intersecting it with the
    capping circle later has no clipping artifacts."""
    perp = np.array([-normal[1], normal[0]])
    near = midpoint - normal * reach
    return Polygon(
        [
            near - perp * reach,
            near + perp * reach,
            midpoint + perp * reach,
            midpoint - perp * reach,
        ]
    )


def build_capped_cells(
    coords: np.ndarray, buffer_meters: float, max_radius_meters: float
) -> List[Polygon]:
    """Build each point's Voronoi cell as an intersection of half-planes against
    its Delaunay/Voronoi-ridge neighbors, buffered outward by `buffer_meters`,
    then capped to a `max_radius_meters` circle around the seed point.

    Falls back to plain capping circles (no Voronoi shape) if Qhull can't
    build a diagram for this point set (e.g. collinear points, too few
    points)."""
    n = len(coords)
    try:
        vor = Voronoi(coords)
    except QhullError:
        return [Point(coords[i]).buffer(max_radius_meters) for i in range(n)]

    reach = max_radius_meters + buffer_meters + 2000  # generous margin

    neighbors: Dict[int, List[int]] = {i: [] for i in range(n)}
    for p1, p2 in vor.ridge_points:
        neighbors[p1].append(p2)
        neighbors[p2].append(p1)

    cells = []
    for i in range(n):
        seed = coords[i]
        cell = Point(seed).buffer(reach, quad_segs=4)
        for j in neighbors[i]:
            other = coords[j]
            midpoint = (seed + other) / 2
            normal = other - seed
            norm = np.linalg.norm(normal)
            if norm == 0:
                continue  # coincident point, no separating line
            normal = normal / norm
            cell = cell.intersection(half_plane_polygon(midpoint, normal, reach))
        cell = cell.buffer(buffer_meters).intersection(Point(seed).buffer(max_radius_meters))
        cells.append(cell)
    return cells


def compute_transfers(
    stops_dict: Dict[str, List],
    buffer_meters: float = BUFFER_METERS,
    max_radius_meters: float = MAX_RADIUS_METERS,
) -> Tuple[Dict[str, List[List]], Dict[str, List[List]]]:
    """Compute the walkable-transfer graph for a city's stops, split into two
    distinct edge sets that both come out of the same Voronoi computation:

      clusters  -> intra-cluster edges: stops merged into the same proximity-
                   clustered Voronoi seed (typically several stop ids a few
                   meters apart at the same physical station/junction - i.e.
                   "the same place").
      transfers -> inter-cluster edges: walking connections between DIFFERENT
                   Voronoi cells, found via cell adjacency/overlap (i.e.
                   "a different, nearby place").

    Both are {stop_id: [[other_stop_id, distance_m], ...], ...}, sorted by
    distance. This split is intentional: RAPTOR's footpath-relaxation step
    needs both (same-place transfers are ~free, different-place transfers
    cost real walking time), while the "locations" feature only needs
    `clusters` (which stops sit inside the same cell as a given point).
    """
    all_ids = list(stops_dict.keys())
    if len(all_ids) < 2:
        empty = {sid: [] for sid in all_ids}
        return empty, dict(empty)

    lons = [stops_dict[sid][0] for sid in all_ids]
    lats = [stops_dict[sid][1] for sid in all_ids]
    xs, ys = project_to_meters(lons, lats)
    coords = np.array(list(zip(xs, ys)))

    cluster_of = cluster_by_proximity(coords, buffer_meters)
    cluster_members: Dict[int, List[int]] = {}
    for idx, label in enumerate(cluster_of):
        cluster_members.setdefault(label, []).append(idx)

    cluster_labels = list(cluster_members.keys())
    cluster_coords = np.array(
        [coords[cluster_members[label]].mean(axis=0) for label in cluster_labels]
    )

    clusters: Dict[str, List[List]] = {sid: [] for sid in all_ids}
    transfers: Dict[str, List[List]] = {sid: [] for sid in all_ids}

    def real_dist(i: int, j: int) -> float:
        return float(np.linalg.norm(coords[i] - coords[j]))

    def add_edge(target: Dict[str, List[List]], i: int, j: int, dist: float):
        if dist > max_radius_meters:
            return
        a, b = all_ids[i], all_ids[j]
        target[a].append([b, round(dist, 1)])
        target[b].append([a, round(dist, 1)])

    # Intra-cluster edges: stops grouped together as within the overlap threshold.
    for members in cluster_members.values():
        for i, j in combinations(members, 2):
            add_edge(clusters, i, j, real_dist(i, j))

    # Inter-cluster edges via Voronoi over cluster centroids.
    if len(cluster_labels) < 2:
        pass
    elif len(cluster_labels) < 4:
        # Not enough distinct clusters for a meaningful Voronoi diagram -
        # fall back to direct pairwise distance capped at max_radius_meters.
        for ci, cj in combinations(range(len(cluster_labels)), 2):
            centroid_dist = float(np.linalg.norm(cluster_coords[ci] - cluster_coords[cj]))
            if centroid_dist > max_radius_meters + buffer_meters:
                continue
            for i in cluster_members[cluster_labels[ci]]:
                for j in cluster_members[cluster_labels[cj]]:
                    add_edge(transfers, i, j, real_dist(i, j))
    else:
        cells = build_capped_cells(cluster_coords, buffer_meters, max_radius_meters)
        tree = STRtree(cells)
        seen_pairs = set()
        for ci, cell in enumerate(cells):
            for cj in tree.query(cell):
                cj = int(cj)
                if cj <= ci:
                    continue
                pair = (ci, cj)
                if pair in seen_pairs:
                    continue
                seen_pairs.add(pair)
                if not cell.intersects(cells[cj]):
                    continue
                for i in cluster_members[cluster_labels[ci]]:
                    for j in cluster_members[cluster_labels[cj]]:
                        add_edge(transfers, i, j, real_dist(i, j))

    for sid in clusters:
        clusters[sid].sort(key=lambda e: e[1])
    for sid in transfers:
        transfers[sid].sort(key=lambda e: e[1])
    return transfers, clusters


def main():
    parser = argparse.ArgumentParser(
        description='Precompute walkable-transfer neighbors between stops (Voronoi-based)'
    )
    parser.add_argument('--city', type=str, help='City name (uses $city/stops.min.json)')
    parser.add_argument('--stops-file', type=str, help='Path to stops.min.json (if not using --city)')
    parser.add_argument('--output', type=str, help='Output path for transfers.min.json')
    parser.add_argument('--clusters-output', type=str, help='Output path for clusters.min.json')
    parser.add_argument(
        '--buffer-meters', type=float, default=BUFFER_METERS,
        help=f'How far (meters) cells may overlap, and the proximity-clustering '
             f'threshold for near-duplicate stops (default: {BUFFER_METERS})'
    )
    parser.add_argument(
        '--max-radius-meters', type=float, default=MAX_RADIUS_METERS,
        help=f'Hard cap (meters) on a cell\'s extent from its stop, and on any '
             f'resulting transfer edge distance (default: {MAX_RADIUS_METERS})'
    )
    args = parser.parse_args()

    if args.city:
        city_dir = args.city
        stops_file = os.path.join(city_dir, 'stops.min.json')
        output_file = args.output or os.path.join(city_dir, 'transfers.min.json')
        clusters_output_file = args.clusters_output or os.path.join(city_dir, 'clusters.min.json')
    elif args.stops_file:
        stops_file = args.stops_file
        parent_dir = str(Path(stops_file).parent)
        output_file = args.output or os.path.join(parent_dir, 'transfers.min.json')
        clusters_output_file = args.clusters_output or os.path.join(parent_dir, 'clusters.min.json')
    else:
        print('Error: provide either --city or --stops-file')
        return 1

    if not os.path.isfile(stops_file):
        print(f'Error: stops file not found: {stops_file}')
        return 1

    print(f'Loading stops from: {stops_file}')
    stops_dict = load_stops(stops_file)
    print(f'Found {len(stops_dict):,} stops')

    print(
        'Computing Voronoi-based transfer graph '
        f'(buffer={args.buffer_meters}m, cap={args.max_radius_meters}m)...'
    )
    transfers, clusters = compute_transfers(stops_dict, args.buffer_meters, args.max_radius_meters)

    total_edges = sum(len(v) for v in transfers.values())
    print(f'Computed {total_edges:,} directed transfer edges across {len(transfers):,} stops')
    clustered_stops = sum(1 for v in clusters.values() if v)
    print(f'{clustered_stops:,} stops share a Voronoi cell with at least one other stop')

    transfers_sorted = dict(sorted(transfers.items()))
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(transfers_sorted, f, separators=(',', ':'))
    print(f'Wrote: {output_file}')

    clusters_sorted = dict(sorted(clusters.items()))
    with open(clusters_output_file, 'w', encoding='utf-8') as f:
        json.dump(clusters_sorted, f, separators=(',', ':'))
    print(f'Wrote: {clusters_output_file}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())