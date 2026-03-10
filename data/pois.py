#!/usr/bin/env python3
"""
Fetch Points of Interest (metro stations, bus stations, railway stations, airports)
from OpenStreetMap via Overpass API and save as pois.csv for a city.

The bounding box is derived from the city's stops.min.json file.

Usage:
    python pois.py --city CITY_NAME
"""

import argparse
import csv
import json
import math
import sys
import time
from pathlib import Path

import requests

SCRIPT_DIR = Path(__file__).parent
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
BBOX_PAD = 0.05  # degrees padding around stops bounding box


def get_bbox_from_stops(city: str) -> tuple[float, float, float, float]:
    stops_file = SCRIPT_DIR / city / "stops.min.json"
    if not stops_file.exists():
        print(f"Error: {stops_file} not found. Run routes.py first.", file=sys.stderr)
        sys.exit(1)

    with open(stops_file, encoding="utf-8") as f:
        stops = json.load(f)

    lats = []
    lons = []
    for stop_data in stops.values():
        lon, lat = stop_data[0], stop_data[1]
        lons.append(lon)
        lats.append(lat)

    return (
        min(lats) - BBOX_PAD,
        min(lons) - BBOX_PAD,
        max(lats) + BBOX_PAD,
        max(lons) + BBOX_PAD,
    )


def run_overpass_query(query: str, label: str, retries: int = 3) -> list[dict]:
    for attempt in range(retries):
        try:
            print(f"  Fetching {label} (attempt {attempt + 1})...")
            response = requests.post(OVERPASS_URL, data={"data": query}, timeout=90)
            response.raise_for_status()
            return response.json().get("elements", [])
        except (requests.exceptions.Timeout, requests.exceptions.HTTPError) as e:
            if attempt < retries - 1:
                wait = 10 * (attempt + 1)
                print(f"  {label}: {e}, retrying in {wait}s...")
                time.sleep(wait)
            else:
                print(f"  {label}: failed after {retries} attempts: {e}", file=sys.stderr)
                return []


NAME_COLOR_MAP = {
    "purple": "#800080",
    "violet": "#800080",
    "green": "#008000",
    "yellow": "#FFD700",
    "gold": "#FFD700",
    "blue": "#0000FF",
    "red": "#FF0000",
    "orange": "#FF8C00",
    "pink": "#FF69B4",
    "magenta": "#FF00FF",
    "aqua": "#00CED1",
    "silver": "#C0C0C0",
    "grey": "#808080",
    "gray": "#808080",
    "brown": "#8B4513",
}


def color_from_name(name: str) -> str:
    lower = name.lower()
    for keyword, hex_color in NAME_COLOR_MAP.items():
        if keyword in lower:
            return hex_color
    return ""


def fetch_metro_route_colors(
    bbox: tuple[float, float, float, float],
) -> list[tuple[float, float, str]]:
    """Fetch metro/light_rail route relations and build a list of (lat, lon, colour).

    For each relation we resolve the colour via: relation tag → member node tag →
    colour keyword in relation name.  We then output (lat, lon, colour) for every
    member node that has coordinates, so that station nodes from the separate metro
    query can be matched by proximity (station nodes and stop_position nodes are
    different OSM objects with different IDs).
    """
    south, west, north, east = bbox
    bb = f"{south},{west},{north},{east}"

    query = f"""
[out:json][timeout:60][bbox:{bb}];
(
  relation["route"="subway"];
  relation["route"="light_rail"];
);
out body;
>;
out;
"""
    elements = run_overpass_query(query, "metro-routes")
    time.sleep(2)

    relations = [e for e in elements if e.get("type") == "relation"]
    nodes_by_id = {
        e["id"]: e for e in elements if e.get("type") == "node"
    }

    colored_points: list[tuple[float, float, str]] = []

    for rel in relations:
        rel_tags = rel.get("tags", {})
        rel_color = rel_tags.get("colour", rel_tags.get("color", ""))

        member_node_ids = [
            m["ref"] for m in rel.get("members", []) if m.get("type") == "node"
        ]

        if not rel_color:
            for nid in member_node_ids:
                tags = nodes_by_id.get(nid, {}).get("tags", {})
                rel_color = tags.get("colour", tags.get("color", ""))
                if rel_color:
                    break

        if not rel_color:
            rel_color = color_from_name(rel_tags.get("name", ""))

        if rel_color:
            for nid in member_node_ids:
                node = nodes_by_id.get(nid)
                if node and "lat" in node and "lon" in node:
                    colored_points.append((node["lat"], node["lon"], rel_color))

    return colored_points


def fetch_pois(bbox: tuple[float, float, float, float]) -> tuple[list[dict], list[tuple[float, float, str]]]:
    south, west, north, east = bbox
    bb = f"{south},{west},{north},{east}"
    print(f"Fetching POIs from OpenStreetMap for bbox: {bb}")

    metro_route_colors = fetch_metro_route_colors(bbox)
    print(f"    metro-routes: {len(metro_route_colors)} coloured coordinate points")

    queries = {
        "metro": f"""
[out:json][timeout:60][bbox:{bb}];
(
  node["railway"="station"]["station"="subway"];
  node["railway"="station"]["station"="light_rail"];
  node["station"="subway"];
  node["station"="light_rail"];
);
out center;
""",
        "bus": f"""
[out:json][timeout:60][bbox:{bb}];
(
  node["amenity"="bus_station"];
  way["amenity"="bus_station"];
  relation["amenity"="bus_station"];
);
out center;
""",
        "railway": f"""
[out:json][timeout:60][bbox:{bb}];
(
  node["railway"="station"][!"station"];
  node["railway"="station"]["station"="yes"];
  node["railway"="station"]["station"="train"];
  node["building"="train_station"];
);
out center;
""",
        "airport": f"""
[out:json][timeout:60][bbox:{bb}];
(
  node["aeroway"="aerodrome"];
  way["aeroway"="aerodrome"];
  relation["aeroway"="aerodrome"];
);
out center;
""",
    }

    all_elements = []
    for label, query in queries.items():
        elements = run_overpass_query(query, label)
        print(f"    {label}: {len(elements)} elements")
        all_elements.extend(elements)
        time.sleep(2)

    return all_elements, metro_route_colors


def classify_poi(element: dict) -> str | None:
    tags = element.get("tags", {})

    station_type = tags.get("station", "")
    if station_type in ("subway", "light_rail"):
        return "metro"

    if tags.get("amenity") == "bus_station":
        return "bus"

    if tags.get("aeroway") == "aerodrome":
        return "airport"

    if tags.get("railway") == "station" or tags.get("building") == "train_station":
        return "railway"

    return None


def extract_metro_color(element: dict) -> str:
    tags = element.get("tags", {})
    return tags.get("colour", tags.get("color", ""))


MATCH_RADIUS_M = 500


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def nearest_route_color(
    lat: float, lon: float, colored_points: list[tuple[float, float, str]],
) -> str:
    best_color = ""
    best_dist = MATCH_RADIUS_M
    for plat, plon, pcolor in colored_points:
        d = haversine_m(lat, lon, plat, plon)
        if d < best_dist:
            best_dist = d
            best_color = pcolor
    return best_color


def extract_pois(
    elements: list[dict],
    colored_points: list[tuple[float, float, str]] | None = None,
) -> list[dict]:
    pois = []
    seen = set()
    cpoints = colored_points or []

    for elem in elements:
        tags = elem.get("tags", {})
        name = tags.get("name", "")
        if not name:
            continue

        poi_type = classify_poi(elem)
        if not poi_type:
            continue

        lat = elem.get("lat") or elem.get("center", {}).get("lat")
        lon = elem.get("lon") or elem.get("center", {}).get("lon")
        if lat is None or lon is None:
            continue

        key = (name, poi_type)
        if key in seen:
            continue
        seen.add(key)

        color = ""
        if poi_type == "metro":
            color = extract_metro_color(elem)
            if not color and cpoints:
                color = nearest_route_color(lat, lon, cpoints)

        pois.append({
            "name": name,
            "type": poi_type,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "color": color,
        })

    return pois


def main():
    parser = argparse.ArgumentParser(description="Fetch POIs for a city via Overpass API")
    parser.add_argument("--city", required=True, help="City directory name")
    args = parser.parse_args()

    city = args.city
    city_dir = SCRIPT_DIR / city
    if not city_dir.exists():
        print(f"Error: City directory '{city}' does not exist", file=sys.stderr)
        sys.exit(1)

    bbox = get_bbox_from_stops(city)
    elements, metro_route_colors = fetch_pois(bbox)
    print(f"Received {len(elements)} elements from OSM")

    pois = extract_pois(elements, metro_route_colors)
    print(f"Extracted {len(pois)} unique POIs")

    output_file = city_dir / "pois.csv"
    with open(output_file, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f, fieldnames=["name", "type", "lat", "lon", "color"],
            quoting=csv.QUOTE_NONNUMERIC,
        )
        writer.writeheader()
        writer.writerows(pois)

    print(f"Wrote {len(pois)} POIs to {output_file}")
    for poi_type in ("metro", "bus", "railway", "airport"):
        count = sum(1 for p in pois if p["type"] == poi_type)
        if count:
            print(f"  {poi_type}: {count}")


if __name__ == "__main__":
    main()
