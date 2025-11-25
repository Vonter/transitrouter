#!/usr/bin/env python3
"""
Script to fetch subway/metro route data from OpenStreetMap and generate rail.json
in the same format as existing city rail.json files.

Usage:
    python rail.py --city CITY_NAME [--bbox SOUTH,WEST,NORTH,EAST] [--output OUTPUT_FILE]

Example:
    python rail.py --city "San Francisco" --bbox 37.7,-122.5,37.8,-122.4
    python rail.py --city "London" --bbox 51.3,-0.5,51.7,0.2
"""

import argparse
import json
import sys
import time
from collections import defaultdict
from typing import Dict, List, Optional, Tuple
import requests


# Default values for missing fields
DEFAULT_VALUES = {
    "network": "Metro",
    "operator": None,
    "stop_type": "station",
    "mode": "metro_rail",
    "station_colors": "#000000",
    "line_color": "#000000",
}


def fetch_overpass_data(bbox: Tuple[float, float, float, float], 
                       transport_modes: List[str] = None) -> dict:
    """
    Fetch transit route data from OpenStreetMap using Overpass API.
    
    Args:
        bbox: Bounding box as (south, west, north, east)
        transport_modes: List of transport modes to fetch (default: subway, light_rail, tram)
    
    Returns:
        JSON response from Overpass API
    """
    if transport_modes is None:
        transport_modes = ["subway", "light_rail", "tram"]
    
    # Build Overpass QL query
    mode_filter = "|".join(transport_modes)
    overpass_url = "https://overpass-api.de/api/interpreter"
    
    # Query for routes and their stations
    query = f"""
    [out:json][timeout:180][bbox:{bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}];
    (
      // Get all metro/subway/light rail routes
      relation["route"~"^({mode_filter})$"];
      
      // Get stop_area relations for station color information
      relation["public_transport"="stop_area"];
      
      // Get all metro stations
      node["railway"="station"]["station"~"subway|light_rail"];
      node["railway"="halt"]["station"~"subway|light_rail"];
      node["public_transport"="stop_position"]["train"="yes"];
      
      // Get ways that are part of routes
      way(r);
    );
    out body;
    >;
    out skel qt;
    """
    
    print(f"Fetching data from OpenStreetMap for bbox: {bbox}")
    print(f"Transport modes: {', '.join(transport_modes)}")
    
    response = requests.post(overpass_url, data={"data": query})
    response.raise_for_status()
    
    return response.json()


def normalize_name(name: str) -> str:
    """Normalize station name for consistent formatting."""
    if not name:
        return ""
    return name.lower().strip()


def normalize_color_to_hex(color_value: str) -> str:
    """
    Normalize a color value to hex format.
    
    Args:
        color_value: Color as hex (#RRGGBB or RRGGBB) or color name
    
    Returns:
        Hex color string with # prefix
    """
    if not color_value:
        return DEFAULT_VALUES["line_color"]
    
    color_value = color_value.strip()
    
    # Already a hex color with #
    if color_value.startswith("#") and len(color_value) == 7:
        return color_value.lower()
    
    # Hex color without #
    if len(color_value) == 6 and all(c in "0123456789abcdefABCDEF" for c in color_value):
        return f"#{color_value.lower()}"
    
    # Common color names to hex mapping
    color_names = {
        "red": "#ff0000", "blue": "#0000ff", "green": "#00ff00", "yellow": "#ffff00",
        "orange": "#ff8800", "purple": "#800080", "pink": "#ffc0cb", "brown": "#a52a2a",
        "grey": "#808080", "gray": "#808080", "aqua": "#00ffff", "silver": "#c0c0c0",
        "gold": "#ffd700", "cyan": "#00ffff", "magenta": "#ff00ff", "lime": "#00ff00",
        "indigo": "#4b0082", "violet": "#ee82ee", "teal": "#008080", "black": "#000000",
        "white": "#ffffff", "maroon": "#800000", "olive": "#808000", "navy": "#000080"
    }
    
    color_lower = color_value.lower()
    if color_lower in color_names:
        return color_names[color_lower]
    
    # Default fallback
    return DEFAULT_VALUES["line_color"]


def get_color_mapping(osm_data: dict) -> Dict[str, str]:
    """
    Build a mapping of station IDs to their line colors (as hex values).
    Stations serving multiple lines get hyphen-separated hex colors.
    
    Checks colors from:
    1. Station node's own colour/color tag
    2. Route relations the station belongs to
    3. stop_area relations the station belongs to
    
    Returns colors in hex format (e.g., "#ff0000-#0000ff" for red and blue lines)
    """
    station_colors = defaultdict(set)
    relations = [elem for elem in osm_data.get("elements", []) if elem.get("type") == "relation"]
    nodes = {str(elem["id"]): elem for elem in osm_data.get("elements", []) if elem.get("type") == "node"}
    
    # First, check station nodes for their own color tags
    for node_id, node in nodes.items():
        tags = node.get("tags", {})
        node_color = tags.get("colour") or tags.get("color")
        if node_color:
            # Normalize to hex color
            hex_color = normalize_color_to_hex(node_color)
            station_colors[node_id].add(hex_color)
    
    # Then check stop_area relations
    for relation in relations:
        if relation.get("type") != "relation":
            continue
        
        tags = relation.get("tags", {})
        
        if tags.get("public_transport") == "stop_area":
            # Get color from stop_area
            area_color = tags.get("colour") or tags.get("color")
            if area_color:
                hex_color = normalize_color_to_hex(area_color)
                # Apply to all members
                for member in relation.get("members", []):
                    if member.get("type") == "node":
                        ref = str(member.get("ref", ""))
                        if ref:
                            station_colors[ref].add(hex_color)
    
    # Finally check route relations
    for relation in relations:
        if relation.get("type") != "relation":
            continue
        
        tags = relation.get("tags", {})
        route_type = tags.get("route", "")
        
        if route_type not in ["subway", "light_rail", "tram"]:
            continue
        
        # Get line color (this is the actual color for the route)
        color = tags.get("colour") or tags.get("color") or DEFAULT_VALUES["line_color"]
        hex_color = normalize_color_to_hex(color)
        
        # Get all members that are stations and assign this route's hex color
        for member in relation.get("members", []):
            if member.get("type") == "node" and member.get("role") in ["stop", "platform", "stop_entry_only", "stop_exit_only", ""]:
                ref = str(member.get("ref", ""))
                if ref:
                    station_colors[ref].add(hex_color)
    
    # Convert sets to sorted hyphen-separated strings
    return {
        station_id: "-".join(sorted(colors)) if colors else DEFAULT_VALUES["station_colors"]
        for station_id, colors in station_colors.items()
    }


def build_stop_area_mapping(osm_data: dict) -> Dict[str, List[str]]:
    """
    Build a mapping from station nodes to stop_position nodes using stop_area relations.
    
    In OSM, stop_area relations connect:
    - stop_position nodes (route members with colors)
    - station/platform nodes (with names for display)
    
    Args:
        osm_data: OSM data from Overpass API
    
    Returns:
        Dictionary mapping station node IDs to list of stop_position node IDs
    """
    station_to_stop_positions = defaultdict(list)
    relations = [elem for elem in osm_data.get("elements", []) if elem.get("type") == "relation"]
    
    for relation in relations:
        tags = relation.get("tags", {})
        
        if tags.get("public_transport") != "stop_area":
            continue
        
        # Collect stop_position and station nodes from this stop_area
        stop_positions = []
        stations = []
        
        for member in relation.get("members", []):
            if member.get("type") != "node":
                continue
            
            role = member.get("role", "")
            ref = str(member.get("ref", ""))
            
            if role == "stop" or role == "stop_entry_only" or role == "stop_exit_only":
                # These are typically stop_position nodes
                stop_positions.append(ref)
            elif role == "platform" or role == "" or role == "station":
                # These are typically station/platform nodes with names
                stations.append(ref)
        
        # Map each station node to all stop_position nodes in the same stop_area
        for station_id in stations:
            for stop_pos_id in stop_positions:
                if stop_pos_id not in station_to_stop_positions[station_id]:
                    station_to_stop_positions[station_id].append(stop_pos_id)
    
    return dict(station_to_stop_positions)


def extract_stations(osm_data: dict, color_mapping: Dict[str, str], 
                     stop_area_mapping: Dict[str, List[str]], fallback_colors: List[str]) -> List[dict]:
    """
    Extract station features from OSM data.
    
    Args:
        osm_data: OSM data from Overpass API
        color_mapping: Mapping of stop_position node IDs to their colors
        stop_area_mapping: Mapping of station node IDs to lists of stop_position node IDs
        fallback_colors: List of route colors to use as fallback
    
    Returns:
        List of GeoJSON Point features for stations
    """
    stations = []
    seen_coords = set()
    seen_names = {}  # Track stations by name to merge duplicates
    
    nodes = [elem for elem in osm_data.get("elements", []) if elem.get("type") == "node"]
    
    print(f"Stop area mapping has {len(stop_area_mapping)} entries")
    
    # First pass: collect all nodes that are in the color_mapping (route members)
    priority_node_ids = set(color_mapping.keys())
    
    for node in nodes:
        tags = node.get("tags", {})
        
        # Check if this is a transit station
        railway = tags.get("railway", "")
        station = tags.get("station", "")
        public_transport = tags.get("public_transport", "")
        node_id = str(node.get("id", ""))
        
        # Prioritize nodes that are route members (in color_mapping)
        is_route_member = node_id in priority_node_ids
        
        is_station = (
            is_route_member or  # Always include route members
            (railway in ["station", "halt"] and station in ["subway", "light_rail"]) or
            (public_transport == "stop_position") or  # Include all stop_position nodes
            (railway == "station" and not station)  # Generic railway station
        )
        
        if not is_station:
            continue
        
        name = tags.get("name", "")
        
        # If this is a route member without a name, try to find it from other data
        if not name and is_route_member:
            # For unnamed route members, we'll skip them as they're likely
            # stop_position nodes without proper station names
            # The actual station nodes with names will be picked up separately
            continue
        
        if not name:
            # Skip unnamed stations that aren't route members
            continue
        
        lat = node.get("lat")
        lon = node.get("lon")
        
        if lat is None or lon is None:
            continue
        
        # Avoid duplicate stations at same location
        coord_key = (round(lat, 6), round(lon, 6))
        if coord_key in seen_coords:
            continue
        seen_coords.add(coord_key)
        
        node_id = str(node.get("id", ""))
        station_colors = color_mapping.get(node_id)
        num_colors = 1  # Default to 1 line
        
        # If not directly in color_mapping, check if this station is mapped to stop_positions via stop_area
        if not station_colors and node_id in stop_area_mapping:
            # Collect colors from all stop_position nodes linked to this station
            stop_position_ids = stop_area_mapping[node_id]
            all_colors = set()
            for stop_pos_id in stop_position_ids:
                stop_colors = color_mapping.get(stop_pos_id)
                if stop_colors:
                    # Split and add individual colors
                    all_colors.update(stop_colors.split("-"))
            
            if all_colors:
                num_colors = len(all_colors)
                # If station serves multiple lines, use black (#000000)
                if num_colors > 1:
                    station_colors = "#000000"
                else:
                    station_colors = list(all_colors)[0]
        
        # Fallback logic: use route colors if station has no explicit colors
        if not station_colors:
            if fallback_colors:
                num_colors = len(fallback_colors)
                # If multiple route colors exist, use black
                if num_colors > 1:
                    station_colors = "#000000"
                else:
                    station_colors = fallback_colors[0]
            else:
                # Final fallback to default
                station_colors = DEFAULT_VALUES["station_colors"]
                num_colors = 1
        else:
            # If we got colors from color_mapping directly, count them
            if '-' in station_colors:
                num_colors = len(station_colors.split("-"))
        
        network_count = num_colors
        
        feature = {
            "type": "Feature",
            "properties": {
                "name": name,
                "name_norm": normalize_name(name),
                "network": tags.get("network", DEFAULT_VALUES["network"]),
                "operator": tags.get("operator", DEFAULT_VALUES["operator"]),
                "station_colors": station_colors,
                "network_count": network_count,
                "stop_type": DEFAULT_VALUES["stop_type"],
            },
            "geometry": {
                "type": "Point",
                "coordinates": [lon, lat]
            }
        }
        
        # Add mode if present in Delhi format
        if "mode" in tags:
            feature["properties"]["mode"] = tags["mode"]
        
        stations.append(feature)
    
    return stations


def get_route_colors(osm_data: dict) -> List[str]:
    """
    Extract all unique route colors from the OSM data.
    
    Args:
        osm_data: OSM data from Overpass API
    
    Returns:
        List of unique hex color values from all routes
    """
    colors = set()
    relations = [elem for elem in osm_data.get("elements", []) if elem.get("type") == "relation"]
    
    for relation in relations:
        tags = relation.get("tags", {})
        route_type = tags.get("route", "")
        
        if route_type not in ["subway", "light_rail", "tram"]:
            continue
        
        # Get line color
        color = tags.get("colour") or tags.get("color")
        if color:
            hex_color = normalize_color_to_hex(color)
            colors.add(hex_color)
    
    return list(colors)


def extract_routes(osm_data: dict, nodes_dict: Dict[str, dict]) -> List[dict]:
    """
    Extract route LineString features from OSM data.
    
    Only uses way members from route relations, properly connecting them
    without creating straight lines between disconnected segments.
    
    Args:
        osm_data: OSM data from Overpass API
        nodes_dict: Dictionary mapping node IDs to node data
    
    Returns:
        List of GeoJSON LineString features for routes
    """
    routes = []
    relations = [elem for elem in osm_data.get("elements", []) if elem.get("type") == "relation"]
    ways_dict = {str(elem["id"]): elem for elem in osm_data.get("elements", []) if elem.get("type") == "way"}
    
    for relation in relations:
        tags = relation.get("tags", {})
        route_type = tags.get("route", "")
        
        if route_type not in ["subway", "light_rail", "tram"]:
            continue
        
        route_name = tags.get("name", "")
        if not route_name:
            continue
        
        # Get line properties
        line_ref = tags.get("ref", "")
        line_color = tags.get("colour") or tags.get("color") or DEFAULT_VALUES["line_color"]
        if not line_color.startswith("#"):
            line_color = f"#{line_color}" if len(line_color) == 6 else DEFAULT_VALUES["line_color"]
        
        network = tags.get("network", DEFAULT_VALUES["network"])
        operator = tags.get("operator", DEFAULT_VALUES["operator"])
        
        # Extract way members and build coordinates properly
        # Only use ways that are actual route members (not stops/platforms)
        way_segments = []
        for member in relation.get("members", []):
            # Only process way members with empty role or specific route roles
            if member.get("type") == "way" and member.get("role", "") in ["", "forward", "backward"]:
                way_id = str(member.get("ref", ""))
                way = ways_dict.get(way_id)
                if way:
                    way_nodes = way.get("nodes", [])
                    segment_coords = []
                    for node_id in way_nodes:
                        node = nodes_dict.get(str(node_id))
                        if node and "lat" in node and "lon" in node:
                            segment_coords.append([node["lon"], node["lat"]])
                    
                    if len(segment_coords) >= 2:
                        way_segments.append(segment_coords)
        
        if not way_segments:
            # No valid way segments found
            continue
        
        # Connect way segments that share endpoints
        coordinates = connect_way_segments(way_segments)
        
        if len(coordinates) < 2:
            # Skip routes with insufficient coordinates
            continue
        
        feature = {
            "type": "Feature",
            "properties": {
                "line_color": line_color,
                "name": route_name,
                "ref": line_ref,
                "network": network,
                "operator": operator,
                "stop_type": "",
            },
            "geometry": {
                "type": "LineString",
                "coordinates": coordinates
            }
        }
        
        routes.append(feature)
    
    return routes


def connect_way_segments(segments: List[List[List[float]]]) -> List[List[float]]:
    """
    Connect way segments that share endpoints, avoiding straight lines
    between disconnected segments.
    
    Args:
        segments: List of coordinate lists for each way segment
    
    Returns:
        List of coordinates forming a connected path
    """
    if not segments:
        return []
    
    if len(segments) == 1:
        return segments[0]
    
    # Try to connect segments by matching endpoints
    connected = [segments[0]]
    remaining = segments[1:]
    
    while remaining:
        last_point = connected[-1][-1]  # Last point of current path
        first_point = connected[-1][0]  # First point of current path
        
        found = False
        for i, segment in enumerate(remaining):
            seg_first = segment[0]
            seg_last = segment[-1]
            
            # Check if segment connects to end of current path
            if points_close(last_point, seg_first):
                connected.append(segment[1:])  # Skip duplicate point
                remaining.pop(i)
                found = True
                break
            elif points_close(last_point, seg_last):
                connected.append(list(reversed(segment))[1:])  # Reverse and skip duplicate
                remaining.pop(i)
                found = True
                break
            # Check if segment connects to beginning of current path
            elif points_close(first_point, seg_last):
                connected.insert(0, segment[:-1])  # Skip duplicate point
                remaining.pop(i)
                found = True
                break
            elif points_close(first_point, seg_first):
                connected.insert(0, list(reversed(segment))[:-1])  # Reverse and skip duplicate
                remaining.pop(i)
                found = True
                break
        
        if not found:
            # No connecting segment found, start a new path if remaining segments exist
            # This handles disconnected route parts
            break
    
    # Flatten the connected segments
    result = []
    for segment in connected:
        if isinstance(segment[0], list):
            result.extend(segment)
        else:
            result.append(segment)
    
    return result


def points_close(p1: List[float], p2: List[float], tolerance: float = 1e-6) -> bool:
    """
    Check if two coordinate points are close enough to be considered connected.
    
    Args:
        p1: First point [lon, lat]
        p2: Second point [lon, lat]
        tolerance: Distance tolerance
    
    Returns:
        True if points are within tolerance
    """
    return abs(p1[0] - p2[0]) < tolerance and abs(p1[1] - p2[1]) < tolerance


def generate_rail_json(city_name: str, bbox: Tuple[float, float, float, float],
                      transport_modes: List[str] = None,
                      output_file: Optional[str] = None) -> dict:
    """
    Generate rail.json for a city by fetching data from OpenStreetMap.
    
    Args:
        city_name: Name of the city
        bbox: Bounding box as (south, west, north, east)
        transport_modes: List of transport modes (default: subway, light_rail, tram)
        output_file: Optional output file path
    
    Returns:
        GeoJSON FeatureCollection
    """
    # Fetch data from OSM
    osm_data = fetch_overpass_data(bbox, transport_modes)
    
    print(f"Received {len(osm_data.get('elements', []))} elements from OSM")
    
    # Build lookup dictionaries
    nodes_dict = {
        str(elem["id"]): elem 
        for elem in osm_data.get("elements", []) 
        if elem.get("type") == "node"
    }
    
    # Build stop_area mapping (connects station nodes to stop_position nodes)
    print("Building stop_area mapping...")
    stop_area_mapping = build_stop_area_mapping(osm_data)
    print(f"Mapped {len(stop_area_mapping)} station nodes to stop_position nodes")
    
    # Build color mapping
    print("Building station color mapping...")
    color_mapping = get_color_mapping(osm_data)
    
    # Get all route colors for fallback
    print("Collecting route colors...")
    route_colors = get_route_colors(osm_data)
    if route_colors:
        print(f"Found {len(route_colors)} unique route colors: {', '.join(route_colors)}")
    
    # Extract stations and routes
    print("Extracting stations...")
    stations = extract_stations(osm_data, color_mapping, stop_area_mapping, route_colors)
    print(f"Found {len(stations)} stations")
    
    print("Extracting routes...")
    routes = extract_routes(osm_data, nodes_dict)
    print(f"Found {len(routes)} routes")
    
    # Combine into FeatureCollection
    feature_collection = {
        "type": "FeatureCollection",
        "generator": "rail.py",
        "features": stations + routes
    }
    
    # Write to file if specified
    if output_file:
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(feature_collection, f, indent=2, ensure_ascii=False)
        print(f"\nWrote rail.json to {output_file}")
    
    return feature_collection


def parse_bbox(bbox_str: str) -> Tuple[float, float, float, float]:
    """Parse bounding box string into tuple of floats."""
    try:
        parts = [float(x.strip()) for x in bbox_str.split(",")]
        if len(parts) != 4:
            raise ValueError("Bounding box must have exactly 4 values")
        return tuple(parts)
    except (ValueError, AttributeError) as e:
        raise ValueError(f"Invalid bounding box format: {e}")


def main():
    parser = argparse.ArgumentParser(
        description="Fetch subway/metro data from OpenStreetMap and generate rail.json",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # San Francisco BART
  python rail.py --city "San Francisco" --bbox 37.7,-122.5,37.8,-122.4

  # London Underground
  python rail.py --city "London" --bbox 51.3,-0.5,51.7,0.2
  
  # Tokyo Metro
  python rail.py --city "Tokyo" --bbox 35.5,139.5,35.8,139.9

  # Specify output file
  python rail.py --city "Boston" --bbox 42.2,-71.2,42.4,-71.0 --output boston/rail.json

  # Include trams
  python rail.py --city "Melbourne" --bbox -37.9,144.8,-37.7,145.1 --modes subway light_rail tram

Note: Bounding box format is SOUTH,WEST,NORTH,EAST (minlat,minlon,maxlat,maxlon)
"""
    )
    
    parser.add_argument(
        "--city",
        required=True,
        help="Name of the city"
    )
    
    parser.add_argument(
        "--bbox",
        required=True,
        help="Bounding box as SOUTH,WEST,NORTH,EAST (e.g., 37.7,-122.5,37.8,-122.4)"
    )
    
    parser.add_argument(
        "--output",
        help="Output file path (default: rail.json)"
    )
    
    parser.add_argument(
        "--modes",
        nargs="+",
        default=["subway", "light_rail"],
        help="Transport modes to include (default: subway light_rail)"
    )
    
    args = parser.parse_args()
    
    # Parse bounding box
    try:
        bbox = parse_bbox(args.bbox)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    
    # Set output file
    output_file = args.output or "rail.json"
    
    # Generate rail.json
    try:
        generate_rail_json(
            city_name=args.city,
            bbox=bbox,
            transport_modes=args.modes,
            output_file=output_file
        )
        print("\n✓ Successfully generated rail.json")
    except requests.RequestException as e:
        print(f"\nError fetching data from OpenStreetMap: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"\nError generating rail.json: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()

