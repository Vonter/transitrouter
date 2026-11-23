#!/usr/bin/env python3
"""
One-off migration script: builds functions/api/bmtc/blr-id-mapping.js,
bridging local (community GTFS) route/stop ids to Namma BMTC's opaque
live-tracking ids (production.zophop.com). Temporary artifact, not wired
into data/routes.py — run manually to refresh.

Namma BMTC has no bulk route-listing endpoint, so this fetches its whole
BMTC catalog (~105MB), groups entries by route_name (each route splits
into one entry per direction), and for each local route (driven from
services.min.json, which also gives stop sequences) matches by name then
CONFIRMS via stop-sequence geo/name similarity — never guessed on name
alone. While walking each confirmed route's stops, builds a per-route
local-stop -> Namma BMTC stop id crosswalk (Namma BMTC often assigns a
different stop id per direction for what the community GTFS treats as one
stop, so this is kept per-route rather than collapsed). The legacy numeric
GTFS-RT route id is read from the existing blr-route-mapping.js before it's
replaced, since that space is unrelated to Namma BMTC's ids.

Stops are matched only against the stops that show on the local route
itself: each Namma BMTC direction is aligned, in order, to the local stop
sequence (direction) it best fits, so a stop can never snap to an unrelated
nearby stop (e.g. the duplicate across the road that no route serves).
Namma stops the alignment can't place fall back to the nearest stop on any
of that route's sequences; anything still unplaced is reported, not guessed.

Namma BMTC's per-stop `short_id` looked like a shortcut but isn't reliable
(spot-checked live: one stop's short_id pointed at an unrelated local
stop) — geo+name matching is used instead.

Usage: python3 scripts/build_blr_id_mapping.py [--distance-threshold-m 100]
       [--confirm-threshold-m 300] [--report PATH] [--dry-run]
"""
import argparse
import difflib
import json
import math
import re
from collections import defaultdict
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).parent.parent
STOPS_PATH = REPO_ROOT / 'data' / 'blr' / 'stops.min.json'
SERVICES_PATH = REPO_ROOT / 'data' / 'blr' / 'services.min.json'
OLD_MAPPING_PATH = REPO_ROOT / 'functions' / 'api' / 'bmtc' / 'blr-route-mapping.js'
JS_OUTPUT_PATH = REPO_ROOT / 'functions' / 'api' / 'bmtc' / 'blr-id-mapping.js'
DEFAULT_REPORT_PATH = REPO_ROOT / 'scripts' / 'blr_id_mapping_report.txt'

NAMMA_BMTC_ROUTES_URL = 'https://production.zophop.com/scheduler_v4/v4/bengaluru/routes/id'
NAMMA_BMTC_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) '
        'Gecko/20100101 Firefox/144.0'
    ),
    'Accept': 'application/json, text/plain, */*',
}

def normalize_name(name: str) -> str:
    return re.sub(r'\s+', '', (name or '').strip().upper())


def haversine_m(lon1, lat1, lon2, lat2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def name_similarity(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, normalize_name(a), normalize_name(b)).ratio()


def route_sequences(local_name: str, services: dict) -> list:
    """Distinct multi-stop local stop sequences (one per direction/variant)."""
    seen = set()
    out = []
    for key, sequences in (services.get(local_name) or {}).items():
        if key == 'name':
            continue
        for seq in sequences:
            if len(seq) > 1 and tuple(seq) not in seen:
                seen.add(tuple(seq))
                out.append(list(seq))
    return out


def align_sequence(namma_seq: list, local_seq: list, stops: dict, max_distance_m: float):
    """Order-preserving alignment of a Namma BMTC stop sequence onto one
    local sequence (a longest-common-subsequence DP where two stops may pair
    if they are within max_distance_m; closer / similarly-named pairs score
    slightly higher). Returns ({namma_index: local_stop_id}, score)."""
    n, m = len(namma_seq), len(local_seq)
    weights = {}
    for i, ns in enumerate(namma_seq):
        lon, lat, name = ns.get('stop_lon'), ns.get('stop_lat'), ns.get('stop_name', '')
        if lon is None or lat is None:
            continue
        for j, local_id in enumerate(local_seq):
            stop = stops.get(local_id)
            if not stop:
                continue
            dist = haversine_m(lon, lat, stop[0], stop[1])
            if dist <= max_distance_m:
                weights[(i, j)] = 1.0 + 0.1 * name_similarity(stop[2], name) - 0.05 * (dist / max_distance_m)

    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            best = max(dp[i - 1][j], dp[i][j - 1])
            w = weights.get((i - 1, j - 1))
            if w is not None:
                best = max(best, dp[i - 1][j - 1] + w)
            dp[i][j] = best

    pairs = {}
    i, j = n, m
    while i > 0 and j > 0:
        w = weights.get((i - 1, j - 1))
        if w is not None and abs(dp[i][j] - (dp[i - 1][j - 1] + w)) < 1e-9:
            pairs[i - 1] = local_seq[j - 1]
            i -= 1
            j -= 1
        elif abs(dp[i][j] - dp[i - 1][j]) < 1e-9:
            i -= 1
        else:
            j -= 1
    return pairs, dp[n][m]


def nearest_on_route(ns: dict, route_stop_ids: list, stops: dict, max_distance_m: float):
    """Fallback: nearest stop among ALL of the route's stops (any
    direction); name similarity breaks near-ties."""
    lon, lat, name = ns.get('stop_lon'), ns.get('stop_lat'), ns.get('stop_name', '')
    if lon is None or lat is None:
        return None
    best = None
    for local_id in route_stop_ids:
        stop = stops.get(local_id)
        if not stop:
            continue
        dist = haversine_m(lon, lat, stop[0], stop[1])
        if dist > max_distance_m:
            continue
        score = name_similarity(stop[2], name) - dist / max_distance_m * 0.5
        if best is None or score > best[0]:
            best = (score, local_id)
    return best[1] if best else None


def _read_js_default_export(path: Path):
    match = re.search(r'export default (\{.*\});?\s*$', path.read_text(), re.DOTALL)
    return json.loads(match.group(1)) if match else None


def load_old_gtfs_rt_route_ids() -> dict:
    """route_short_name -> legacy numeric GTFS-RT route_id.

    The numeric ids can't be derived from any current static feed, so they
    are carried over from the previous blr-id-mapping.js. blr-route-mapping.js
    is only a fallback and only for numeric values: it is now regenerated by
    data/blr/utils.py with "BMTC:<hash>" ids, which are not legacy ids."""
    ids = {}
    if OLD_MAPPING_PATH.exists():
        for name, value in (_read_js_default_export(OLD_MAPPING_PATH) or {}).items():
            if str(value).isdigit():
                ids[name] = str(value)
    if JS_OUTPUT_PATH.exists():
        existing = _read_js_default_export(JS_OUTPUT_PATH) or {}
        for name, entry in (existing.get('routes') or {}).items():
            legacy = entry.split('|', 1)[0]
            if legacy:
                ids[name] = legacy
    if not ids:
        print('Warning: no legacy gtfsRtRouteId values found, they will be omitted for all routes')
    return ids


def fetch_namma_bmtc_routes() -> list:
    print(f'Fetching {NAMMA_BMTC_ROUTES_URL} (mode=bus, ~105MB, this can take a couple minutes)...')
    res = requests.get(
        NAMMA_BMTC_ROUTES_URL, params={'mode': 'bus'}, headers=NAMMA_BMTC_HEADERS, timeout=180,
    )
    res.raise_for_status()
    print(f'  Downloaded {len(res.content) / 1e6:.1f}MB, parsing JSON...')
    return res.json()


def local_terminus_points(local_name: str, services: dict, stops: dict) -> list:
    """First/last stop lon/lat for every destination sequence of a local
    route, used to confirm a Namma BMTC route_name match actually refers to the
    same physical route."""
    points = []
    entry = services.get(local_name) or {}
    for key, sequences in entry.items():
        if key == 'name':
            continue
        for seq in sequences:
            for stop_id in (seq[0], seq[-1]) if seq else ():
                stop = stops.get(stop_id)
                if stop:
                    points.append((stop[0], stop[1]))
    return points


def confirm_variant(candidate: dict, local_points: list, local_stop_names: set, confirm_threshold_m: float) -> bool:
    first = candidate.get('first_stop') or {}
    last = candidate.get('last_stop') or {}
    for namma_bmtc_pt in ((first.get('stop_lon'), first.get('stop_lat')), (last.get('stop_lon'), last.get('stop_lat'))):
        if namma_bmtc_pt[0] is None or namma_bmtc_pt[1] is None:
            continue
        for local_pt in local_points:
            if haversine_m(namma_bmtc_pt[0], namma_bmtc_pt[1], local_pt[0], local_pt[1]) <= confirm_threshold_m:
                return True

    # Fallback: stop-name overlap ratio across the whole sequence.
    seq = candidate.get('stopSequenceWithDetails') or []
    if not seq or not local_stop_names:
        return False
    matched = 0
    for namma_bmtc_stop in seq:
        cname = normalize_name(namma_bmtc_stop.get('stop_name', ''))
        if any(difflib.SequenceMatcher(None, cname, lname).ratio() > 0.6 for lname in local_stop_names):
            matched += 1
    return (matched / len(seq)) >= 0.5


class IdIndex:
    """Deduplicates repeated Namma BMTC ids (route or stop) into a single array,
    referenced everywhere else by a short integer index instead of the raw
    ~8-char opaque string — the mapping file only needs to be small and
    machine-parseable, not human-readable, and both ids are referenced far
    more times (once per stop a route touches, and once per route serving
    a stop) than there are distinct ids."""

    def __init__(self):
        self._ids = []
        self._to_idx = {}

    def index_of(self, value: str) -> int:
        idx = self._to_idx.get(value)
        if idx is None:
            idx = len(self._ids)
            self._to_idx[value] = idx
            self._ids.append(value)
        return idx

    @property
    def ids(self) -> list:
        return self._ids


def build_mapping(distance_threshold_m: float, confirm_threshold_m: float):
    stops = json.loads(STOPS_PATH.read_text())
    services = json.loads(SERVICES_PATH.read_text())
    old_route_ids = load_old_gtfs_rt_route_ids()

    namma_bmtc_entries = fetch_namma_bmtc_routes()
    bmtc_entries = [e for e in namma_bmtc_entries if e.get('agency_name') == 'BMTC']
    print(f'  {len(namma_bmtc_entries)} total entries, {len(bmtc_entries)} agency_name=="BMTC"')

    by_name = defaultdict(list)
    for e in bmtc_entries:
        by_name[normalize_name(e.get('route_name', ''))].append(e)

    route_ids = IdIndex()  # Namma BMTC route_id string <-> index
    stop_ids = IdIndex()  # Namma BMTC stop_id string <-> index
    routes_map = {}
    stops_map = defaultdict(dict)  # local_stop_id -> {route_idx: stop_idx}
    report = {
        'unmatched_no_candidate': [],
        'unmatched_name_only': [],
        'unresolved_namma_bmtc_stops': [],
        'ambiguous_stop_ids': [],
        'no_local_direction': [],
        'fallback_stop_matches': 0,
        'aligned_stop_matches': 0,
    }

    local_names = sorted(k for k in services.keys())
    print(f'Resolving {len(local_names)} local route names against Namma BMTC catalog...')

    for local_name in local_names:
        candidates = by_name.get(normalize_name(local_name), [])
        if not candidates:
            report['unmatched_no_candidate'].append(local_name)
            continue

        local_points = local_terminus_points(local_name, services, stops)
        local_stop_names = set()
        entry = services.get(local_name) or {}
        for key, sequences in entry.items():
            if key == 'name':
                continue
            for seq in sequences:
                for stop_id in seq:
                    stop = stops.get(stop_id)
                    if stop:
                        local_stop_names.add(normalize_name(stop[2]))

        confirmed = [c for c in candidates if confirm_variant(c, local_points, local_stop_names, confirm_threshold_m)]
        if not confirmed:
            report['unmatched_name_only'].append({
                'local_name': local_name,
                'rejected_candidates': [c['route_id'] for c in candidates],
            })
            continue

        local_sequences = route_sequences(local_name, services)
        route_stop_ids = sorted({sid for q in local_sequences for sid in q})

        namma_bmtc_routes = []
        for c in confirmed:
            seq = c.get('stopSequenceWithDetails') or []
            route_idx = route_ids.index_of(c['route_id'])
            sample_stop_idx = stop_ids.index_of(seq[0]['stop_id']) if seq else ''
            namma_bmtc_routes.append((route_idx, sample_stop_idx))

            # Align this direction onto the local direction it best fits;
            # only stops on the local route are ever candidates.
            aligned = {}
            best_score = 0.0
            for local_seq in local_sequences:
                pairs, score = align_sequence(seq, local_seq, stops, distance_threshold_m)
                if score > best_score:
                    aligned, best_score = pairs, score
            if not aligned:
                report['no_local_direction'].append({'route_name': local_name, 'route_id': c['route_id']})

            for k, namma_bmtc_stop in enumerate(seq):
                name = namma_bmtc_stop.get('stop_name', '')
                local_stop_id = aligned.get(k)
                if local_stop_id is not None:
                    report['aligned_stop_matches'] += 1
                else:
                    local_stop_id = nearest_on_route(namma_bmtc_stop, route_stop_ids, stops, distance_threshold_m)
                    if local_stop_id is not None:
                        report['fallback_stop_matches'] += 1
                if local_stop_id is None:
                    report['unresolved_namma_bmtc_stops'].append({
                        'route_name': local_name, 'stop_id': namma_bmtc_stop.get('stop_id'),
                        'stop_name': name, 'lon': namma_bmtc_stop.get('stop_lon'), 'lat': namma_bmtc_stop.get('stop_lat'),
                    })
                    continue
                # Keyed by (local_stop_id, namma_bmtc_route_id): each
                # direction's own alignment already picks the right
                # directional stop. A genuine conflict (the same direction
                # visiting one local stop twice with different Namma stop
                # ids, e.g. a loop's start/end) keeps the first and is logged.
                stop_idx = stop_ids.index_of(namma_bmtc_stop['stop_id'])
                existing = stops_map[local_stop_id].get(route_idx)
                if existing is not None and existing != stop_idx:
                    report['ambiguous_stop_ids'].append({
                        'local_stop_id': local_stop_id, 'route_id': c['route_id'],
                        'kept_namma_bmtc_id': stop_ids.ids[existing], 'rejected_namma_bmtc_id': namma_bmtc_stop['stop_id'],
                    })
                else:
                    stops_map[local_stop_id][route_idx] = stop_idx

        # Compact, non-human-readable encoding to keep the generated file
        # small: "<gtfsRtRouteId>|<routeIdx>:<sampleStopIdx>,<routeIdx>:<sampleStopIdx>,..."
        # routeIdx/sampleStopIdx index into the top-level `r`/`s` id arrays
        # (see IdIndex) rather than repeating the ~8-char opaque Namma BMTC id
        # every time it's referenced.
        gtfs_rt_id = old_route_ids.get(local_name) or ''
        variants = ','.join(f'{ridx}:{sidx}' for ridx, sidx in namma_bmtc_routes)
        routes_map[local_name] = f'{gtfs_rt_id}|{variants}'

    # Compact encoding: "<routeIdx>:<stopIdx>,<routeIdx>:<stopIdx>,..." — a
    # per-route stop id (see above), both indexed into `r`/`s`.
    stops_map_out = {
        stop_id: ','.join(f'{ridx}:{sidx}' for ridx, sidx in sorted(route_to_stop_idx.items()))
        for stop_id, route_to_stop_idx in stops_map.items()
    }

    return route_ids.ids, stop_ids.ids, routes_map, stops_map_out, report


def write_report(report: dict, report_path: Path, total_local_routes: int, total_stops_touched: int):
    lines = []
    lines.append('BLR id-mapping migration report (scripts/build_blr_id_mapping.py)')
    lines.append('=' * 70)
    lines.append(f'Total local routes considered: {total_local_routes}')
    lines.append(f'Matched: {total_local_routes - len(report["unmatched_no_candidate"]) - len(report["unmatched_name_only"])}')
    lines.append(f'Unmatched (no Namma BMTC candidate by name): {len(report["unmatched_no_candidate"])}')
    lines.append(f'Unmatched (name matched, geo/stop confirmation failed): {len(report["unmatched_name_only"])}')
    lines.append(f'Local stops touched by confirmed routes: {total_stops_touched}')
    lines.append(f'Unresolved Namma BMTC stops (no stop on the local route within threshold): {len(report["unresolved_namma_bmtc_stops"])}')
    lines.append(f'Ambiguous stop-id reverse mappings: {len(report["ambiguous_stop_ids"])}')
    lines.append(f'Stops placed by direction alignment: {report["aligned_stop_matches"]}')
    lines.append(f'Stops placed by on-route nearest fallback: {report["fallback_stop_matches"]}')
    lines.append(f'Namma directions with no fitting local direction: {len(report["no_local_direction"])}')
    lines.append('')

    lines.append('-- UNMATCHED_NO_CANDIDATE --')
    lines.extend(report['unmatched_no_candidate'] or ['(none)'])
    lines.append('')

    lines.append('-- UNMATCHED_NAME_ONLY --')
    if report['unmatched_name_only']:
        for item in report['unmatched_name_only']:
            lines.append(f'{item["local_name"]}: rejected candidates {item["rejected_candidates"]}')
    else:
        lines.append('(none)')
    lines.append('')

    lines.append('-- UNRESOLVED_NAMMA_BMTC_STOPS --')
    if report['unresolved_namma_bmtc_stops']:
        for item in report['unresolved_namma_bmtc_stops']:
            lines.append(
                f'route={item["route_name"]} stop_id={item["stop_id"]} '
                f'name={item["stop_name"]!r} lon={item["lon"]} lat={item["lat"]}'
            )
    else:
        lines.append('(none)')
    lines.append('')

    lines.append('-- AMBIGUOUS_STOP_IDS (same route, same local stop, two different Namma BMTC stop ids) --')
    if report['ambiguous_stop_ids']:
        for item in report['ambiguous_stop_ids']:
            lines.append(
                f'local_stop_id={item["local_stop_id"]} route_id={item["route_id"]} '
                f'kept={item["kept_namma_bmtc_id"]} rejected={item["rejected_namma_bmtc_id"]}'
            )
    else:
        lines.append('(none)')

    report_path.write_text('\n'.join(lines) + '\n')
    print(f'Wrote report -> {report_path}')


def write_js_module(route_ids, stop_ids, routes_map, stops_map):
    mapping = {'r': route_ids, 's': stop_ids, 'routes': routes_map, 'stops': stops_map}
    js_content = (
        '// Auto-generated by scripts/build_blr_id_mapping.py — do not edit manually\n'
        '// Temporary migration artifact bridging local (community GTFS) ids to\n'
        "// Namma BMTC's opaque live-tracking ids. NOT regenerated by data/routes.py —\n"
        '// re-run scripts/build_blr_id_mapping.py manually to refresh.\n'
        '//\n'
        '// Compact (non-human-readable) encoding to keep file size down: `r`\n'
        '// and `s` are id arrays deduping the ~8-char opaque Namma BMTC route/stop\n'
        '// ids (referenced many times each) into a single array, indexed by\n'
        '// position everywhere else:\n'
        "//   routes[localRouteName] = '<gtfsRtRouteId>|<rIdx>:<sIdx>,...'      (sIdx into `s`, a sample stop for route-live-info)\n"
        "//   stops[localStopId]     = '<rIdx>:<sIdx>,<rIdx>:<sIdx>,...'       (per-route Namma BMTC stop id for this local stop)\n"
        f'export default {json.dumps(mapping, separators=(",", ":"))};\n'
    )
    JS_OUTPUT_PATH.write_text(js_content)
    print(f'Wrote id mapping JS module -> {JS_OUTPUT_PATH}')



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--distance-threshold-m', type=float, default=100)
    parser.add_argument('--confirm-threshold-m', type=float, default=300)
    parser.add_argument('--report', type=Path, default=DEFAULT_REPORT_PATH)
    parser.add_argument('--dry-run', action='store_true', help="Print summary, don't write blr-id-mapping.js")
    args = parser.parse_args()

    route_ids, stop_ids, routes_map, stops_map, report = build_mapping(
        args.distance_threshold_m, args.confirm_threshold_m,
    )

    print(f'Matched {len(routes_map)} routes, touched {len(stops_map)} local stops')
    print(f'{len(route_ids)} distinct Namma BMTC route ids, {len(stop_ids)} distinct Namma BMTC stop ids')
    write_report(report, args.report, len(routes_map) + len(report['unmatched_no_candidate']) + len(report['unmatched_name_only']), len(stops_map))

    if args.dry_run:
        print('--dry-run: not writing blr-id-mapping.js')
        return

    write_js_module(route_ids, stop_ids, routes_map, stops_map)


if __name__ == '__main__':
    main()
