#!/usr/bin/env python3
import json
import polars as pl
import polyline
import argparse
import os
import importlib.util
from pathlib import Path
from typing import Dict, List, Tuple, Set, Optional, Callable
from collections import defaultdict

from utils import (
    read_gtfs_file,
    find_gtfs_files,
    load_gtfs_data_from_multiple_files
)


def load_city_utils(city: str) -> Optional[object]:
    """
    Load city-specific utils module if it exists.
    
    Looks for a utils.py file in the city directory (e.g., blr/utils.py).
    
    Args:
        city: City name/directory
        
    Returns:
        The loaded module, or None if not found
    """
    city_utils_path = Path(city) / 'utils.py'
    
    if not city_utils_path.exists():
        return None
    
    try:
        spec = importlib.util.spec_from_file_location(f"{city}_utils", city_utils_path)
        if spec is None or spec.loader is None:
            return None
        
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        print(f"Loaded city-specific utils from {city_utils_path}")
        return module
    except Exception as e:
        print(f"Warning: Failed to load city utils from {city_utils_path}: {e}")
        return None


def apply_city_stop_processing(
    stops_dict: Dict[str, List],
    gtfs_data: Dict[str, pl.DataFrame],
    valid_routes: Set[str],
    city_utils: Optional[object]
) -> Dict[str, List]:
    """
    Apply city-specific stop name processing if available.
    
    Looks for a `process_stop_names` function in the city utils module.
    
    Args:
        stops_dict: Dictionary of stop_id -> [lon, lat, name, suffix]
        gtfs_data: Dictionary containing GTFS DataFrames
        valid_routes: Set of valid route IDs
        city_utils: City-specific utils module (or None)
        
    Returns:
        Processed stops_dict (possibly modified by city-specific logic)
    """
    if city_utils is None:
        return stops_dict
    
    process_fn = getattr(city_utils, 'process_stop_names', None)
    if process_fn is None:
        return stops_dict
    
    if not callable(process_fn):
        print(f"Warning: process_stop_names in city utils is not callable")
        return stops_dict
    
    return process_fn(stops_dict, gtfs_data, valid_routes)


def apply_city_mapping_generation(
    gtfs_data: Dict[str, pl.DataFrame],
    output_dir: str,
    city_utils: Optional[object],
) -> None:
    """Call city-specific generate_mapping if the city utils module provides it."""
    if city_utils is None:
        return
    generate_fn = getattr(city_utils, 'generate_mapping', None)
    if generate_fn and callable(generate_fn):
        generate_fn(gtfs_data, output_dir)


# Default minimum number of trips per day for a route to be included
DEFAULT_MIN_TRIPS = 2

def get_valid_routes(gtfs_data: Dict[str, pl.DataFrame], min_trips: int) -> Set[str]:
    """Get routes that have at least min_trips in at least one direction."""
    trips_df = gtfs_data['trips']
    routes_df = gtfs_data['routes']
    has_direction = 'direction_id' in trips_df.columns
    
    # Normalize direction_id
    if has_direction:
        trips_df = trips_df.with_columns(
            pl.col('direction_id').fill_null(0).cast(pl.Utf8).alias('direction')
        )
    else:
        # Use UP/DOWN from route names
        trips_df = trips_df.join(
            routes_df.select(['route_id', 'route_long_name']), 
            on='route_id', 
            how='left'
        ).with_columns([
            pl.col('route_long_name').str.to_uppercase().alias('route_upper'),
            pl.when(pl.col('route_long_name').str.to_uppercase().str.contains('UP'))
            .then(pl.lit("0"))
            .when(pl.col('route_long_name').str.to_uppercase().str.contains('DOWN'))
            .then(pl.lit("1"))
            .otherwise(pl.lit("0"))
            .alias('direction')
        ])
    
    # Count trips per route and direction
    trip_counts = trips_df.group_by(['route_id', 'direction']).agg(
        pl.len().alias('count')
    ).pivot(
        values='count',
        index='route_id',
        columns='direction',
        aggregate_function='first'
    ).fill_null(0)
    
    # Return routes with at least min_trips in any direction
    def compute_valid(min_required: int) -> Set[str]:
        # Get all direction columns (excluding route_id)
        direction_cols = [col for col in trip_counts.columns if col != 'route_id']
        if not direction_cols:
            return set()
        
        # Use to_dicts for faster iteration than iter_rows
        valid = set()
        for row in trip_counts.to_dicts():
            route_id = row['route_id']
            # Check all direction columns (excluding route_id)
            counts = [row.get(col, 0) for col in direction_cols]
            if any(c >= min_required for c in counts):
                valid.add(route_id)
        return valid

    valid_routes = compute_valid(min_trips)
    # Fallback for sparse datasets: if nothing qualifies, relax to 1
    if not valid_routes and min_trips > 1:
        valid_routes = compute_valid(1)

    return valid_routes

def process_stops(gtfs_data: Dict[str, pl.DataFrame], valid_routes: Set[str]) -> Dict:
    """Process stops.txt and generate stops.min.json format, filtering out stops with no valid routes."""
    stops_df = gtfs_data['stops']
    trips_df = gtfs_data['trips'].filter(pl.col('route_id').is_in(list(valid_routes)))
    stop_times_df = gtfs_data['stop_times']
    
    # Get stops served by valid routes
    valid_trip_ids = trips_df.select('trip_id')
    valid_stop_ids = stop_times_df.join(
        valid_trip_ids, on='trip_id', how='inner'
    ).select('stop_id').unique()
    
    # Filter and convert to dictionary
    # Join first, then handle parent_station column
    valid_stops = stops_df.join(
        valid_stop_ids, on='stop_id', how='inner'
    )
    
    # Handle parent_station column - fill null values with empty string, or create if missing
    if 'parent_station' in valid_stops.columns:
        valid_stops = valid_stops.select([
            'stop_id', 'stop_lon', 'stop_lat', 'stop_name',
            pl.col('parent_station').fill_null("").alias('parent_station')
        ])
    else:
        # If parent_station column doesn't exist, create a column with empty strings
        valid_stops = valid_stops.select([
            'stop_id', 'stop_lon', 'stop_lat', 'stop_name',
            pl.lit("").alias('parent_station')
        ])
    
    # Convert to dict using to_dicts for better performance
    return {
        row['stop_id']: [
            float(row['stop_lon']), 
            float(row['stop_lat']), 
            row['stop_name'], 
            "",
            row['parent_station'] or ""  # parentStopID - empty string if not set
        ]
        for row in valid_stops.to_dicts()
    }

def encode_polyline(coordinates: List[Tuple[float, float]]) -> str:
    """Encode a list of coordinates into a polyline string."""
    return polyline.encode([(lat, lon) for lat, lon in coordinates])

def generate_mock_shapes_batch(gtfs_data: Dict[str, pl.DataFrame], valid_routes: Set[str]) -> Dict[str, List[str]]:
    """Generate mock shapes for all routes in batch - much more efficient than per-route."""
    trips_df = gtfs_data['trips'].filter(pl.col('route_id').is_in(list(valid_routes)))
    stop_times_df = gtfs_data['stop_times']
    stops_df = gtfs_data['stops']
    routes_df = gtfs_data['routes']
    has_direction = 'direction_id' in trips_df.columns
    
    # Pre-compute direction mapping for all trips
    if has_direction:
        trips_with_dir = trips_df.with_columns(
            pl.col('direction_id').fill_null(0).cast(pl.Utf8).alias('direction')
        )
    else:
        trips_with_dir = trips_df.join(
            routes_df.select(['route_id', 'route_long_name']), 
            on='route_id', 
            how='left'
        ).with_columns(
            pl.when(pl.col('route_long_name').str.to_uppercase().str.contains('UP'))
            .then(pl.lit("0"))
            .when(pl.col('route_long_name').str.to_uppercase().str.contains('DOWN'))
            .then(pl.lit("1"))
            .otherwise(pl.lit("0"))
            .alias('direction')
        )
    
    # Get first trip per route-direction combination
    first_trips = trips_with_dir.group_by(['route_id', 'direction']).agg(
        pl.first('trip_id').alias('trip_id')
    )
    
    # Join with stop_times and stops to get coordinates
    trip_stops_coords = first_trips.join(
        stop_times_df.select(['trip_id', 'stop_id', 'stop_sequence']),
        on='trip_id',
        how='inner'
    ).join(
        stops_df.select(['stop_id', 'stop_lat', 'stop_lon']),
        on='stop_id',
        how='left'
    ).sort(['route_id', 'direction', 'stop_sequence'])
    
    # Group by route_id and direction, then encode polylines
    routes_dict = defaultdict(list)
    
    # Use group_by with aggregation to get coordinates per route-direction
    grouped = trip_stops_coords.group_by(['route_id', 'direction'], maintain_order=True).agg([
        pl.col('stop_lat').alias('lats'),
        pl.col('stop_lon').alias('lons')
    ])
    
    for row in grouped.to_dicts():
        route_id = row['route_id']
        lats = row['lats']
        lons = row['lons']
        if lats and lons:
            coordinates = [(float(lat), float(lon)) for lat, lon in zip(lats, lons)]
            if coordinates:
                routes_dict[route_id].append(encode_polyline(coordinates))
    
    return dict(routes_dict)

def process_routes(gtfs_data: Dict[str, pl.DataFrame], valid_routes: Set[str]) -> Dict:
    """Process shapes.txt (or generate mock shapes) and routes.txt to generate routes.min.json format."""
    # Check for shape_id in original unfiltered trips_df before filtering
    original_trips_df = gtfs_data['trips']
    has_shape_id = (len(original_trips_df) > 0 and 
                   len(original_trips_df.columns) > 0 and 
                   'shape_id' in original_trips_df.columns)
    
    trips_df = original_trips_df.filter(pl.col('route_id').is_in(list(valid_routes)))
    routes_dict = defaultdict(list)
    
    # Check if both shapes.txt exists AND trips have shape_id column AND filtered trips_df has rows and columns
    # Also verify all required columns exist before trying to select them
    # First check if trips_df has any columns at all (handles empty DataFrame case)
    required_cols = ['route_id', 'shape_id']
    has_all_cols = (len(trips_df) > 0 and 
                   len(trips_df.columns) > 0 and 
                   all(col in trips_df.columns for col in required_cols))
    
    # Try to use shapes if available, otherwise fall back to mock shapes
    use_shapes = 'shapes' in gtfs_data and has_shape_id and has_all_cols
    
    if use_shapes:
        shapes_df = gtfs_data['shapes']
        has_direction = 'direction_id' in trips_df.columns
        
        # Get unique route-shape mappings - batch process all shapes
        cols = ['route_id', 'shape_id'] + (['direction_id'] if has_direction else [])
        # Double-check all columns exist before selecting
        if all(col in trips_df.columns for col in cols):
            try:
                route_shapes = trips_df.select(cols).unique()
                
                # Batch process all shapes at once
                print(f"Processing shapes...")
                
                # Group shapes by shape_id and aggregate coordinates
                shapes_grouped = shapes_df.group_by('shape_id', maintain_order=True).agg([
                    pl.col('shape_pt_lat').alias('lats'),
                    pl.col('shape_pt_lon').alias('lons')
                ])
                
                # Create shape_id -> encoded polyline mapping
                shape_encoded = {}
                for row in shapes_grouped.to_dicts():
                    shape_id = row['shape_id']
                    lats = row['lats']
                    lons = row['lons']
                    if lats and lons:
                        coordinates = [(float(lat), float(lon)) for lat, lon in zip(lats, lons)]
                        shape_encoded[shape_id] = encode_polyline(coordinates)
                
                # Map routes to their shapes
                for row in route_shapes.to_dicts():
                    route_id = row['route_id']
                    shape_id = row['shape_id']
                    if shape_id in shape_encoded:
                        routes_dict[route_id].append(shape_encoded[shape_id])
                
                print(f"  Processed {len(shape_encoded):,} unique shapes...")
            except (pl.exceptions.ColumnNotFoundError, KeyError):
                # If selection fails, fall back to mock shapes
                use_shapes = False
    
    if not use_shapes:
        # Generate mock shapes using batch processing
        print(f"Generating mock shapes for {len(valid_routes):,} routes...")
        routes_dict = generate_mock_shapes_batch(gtfs_data, valid_routes)
        print(f"  Generated shapes for {len(routes_dict):,} routes...")

    # Remap keys from route_id to route_short_name (fallback: route_id)
    routes_df = gtfs_data['routes']
    has_short_name = 'route_short_name' in routes_df.columns
    route_key_map = {
        row['route_id']: (row.get('route_short_name') or '').strip() or row['route_id']
        for row in routes_df.select(
            ['route_id'] + (['route_short_name'] if has_short_name else [])
        ).to_dicts()
    }
    return {route_key_map.get(rid, rid): shapes for rid, shapes in routes_dict.items()}

def process_services(gtfs_data: Dict[str, pl.DataFrame], valid_routes: Set[str]) -> Dict:
    """Process trips.txt and stop_times.txt to generate services.min.json format with destination grouping."""
    routes_df = gtfs_data['routes'].filter(pl.col('route_id').is_in(list(valid_routes)))
    trips_df = gtfs_data['trips'].filter(pl.col('route_id').is_in(list(valid_routes)))
    stop_times_df = gtfs_data['stop_times']
    has_direction = 'direction_id' in trips_df.columns
    
    # Pre-compute direction for all trips
    if has_direction:
        trips_with_dir = trips_df.with_columns(
            pl.col('direction_id').fill_null(0).cast(pl.Utf8).alias('direction')
        )
    else:
        trips_with_dir = trips_df.join(
            routes_df.select(['route_id', 'route_long_name']),
            on='route_id',
            how='left'
        ).with_columns(
            pl.when(pl.col('route_long_name').str.to_uppercase().str.contains('UP'))
            .then(pl.lit("0"))
            .when(pl.col('route_long_name').str.to_uppercase().str.contains('DOWN'))
            .then(pl.lit("1"))
            .otherwise(pl.lit("0"))
            .alias('direction')
        )
    
    # Pre-join stop_times with trips to avoid filtering per trip
    trips_stop_times = stop_times_df.join(
        trips_with_dir.select(['trip_id', 'route_id', 'direction']),
        on='trip_id',
        how='inner'
    ).sort(['trip_id', 'stop_sequence'])
    
    # Get last stop per trip (destination)
    trip_destinations = trips_stop_times.group_by('trip_id', maintain_order=True).agg([
        pl.last('stop_id').alias('destination'),
        pl.col('stop_id').alias('stops_list'),
        pl.first('route_id').alias('route_id'),
        pl.first('direction').alias('direction')
    ])
    
    services_dict = {}
    
    total_routes = len(routes_df)
    print(f"Processing {total_routes:,} routes for services...")
    
    # Process each route
    for route_idx, route in enumerate(routes_df.to_dicts(), 1):
        route_id = route['route_id']
        route_key = (route.get('route_short_name') or '').strip() or route_id
        route_name = route['route_long_name']

        # Filter trips for this route
        route_trip_dests = trip_destinations.filter(pl.col('route_id') == route_id)
        
        # Dictionary to group by destination
        destination_groups = defaultdict(lambda: {'routes_map': {}, 'trip_ids': set()})
        
        # Process each direction
        for direction in ["0", "1"]:
            dir_trip_dests = route_trip_dests.filter(pl.col('direction') == direction)
            
            # Group trips by destination and route pattern
            for row in dir_trip_dests.to_dicts():
                trip_id = row['trip_id']
                destination = row['destination']
                stops_list = row['stops_list']
                
                if stops_list:
                    route_tuple = tuple(stops_list)
                    
                    # Track unique routes and their trip counts
                    if route_tuple not in destination_groups[destination]['routes_map']:
                        destination_groups[destination]['routes_map'][route_tuple] = 0
                    destination_groups[destination]['routes_map'][route_tuple] += 1
                    destination_groups[destination]['trip_ids'].add(trip_id)
        
        # Calculate total trips for each destination and prepare output format
        destination_data = {}
        for destination, data in destination_groups.items():
            # Get all unique route variations for this destination
            routes_list = [list(route_tuple) for route_tuple in data['routes_map'].keys()]
            trip_count = len(data['trip_ids'])
            
            destination_data[destination] = {
                'routes': routes_list,
                'trip_count': trip_count
            }
        
        # Sort destinations by trip_count (descending)
        sorted_destinations = sorted(
            destination_data.items(),
            key=lambda x: x[1]['trip_count'],
            reverse=True
        )

        # Create final format without nested "routes" key and without trip_count
        services_dict[route_key] = {
            "name": route_name
        }
        # Add destinations directly (not nested under "routes" key)
        for dest, data in sorted_destinations:
            services_dict[route_key][dest] = data['routes']
        
        if route_idx % 50 == 0:
            print(f"  Processed {route_idx:,}/{total_routes:,} routes ({100*route_idx/total_routes:.1f}%)...")
    
    return services_dict

def main():
    """Main function to process GTFS and generate JSON files."""
    parser = argparse.ArgumentParser(description='Process GTFS data with minimum trips filter')
    parser.add_argument('--min-trips', type=int, default=DEFAULT_MIN_TRIPS,
                      help=f'Minimum number of trips per day for a route to be included (default: {DEFAULT_MIN_TRIPS})')
    parser.add_argument('--output-dir', type=str, default='.',
                      help='Output directory for JSON files (default: current directory)')
    parser.add_argument('--city', type=str,
                      help='City name (if provided, uses all .zip GTFS files in $city/ and output goes to $city/)')
    parser.add_argument('--gtfs-path', type=str,
                      help='Path to a single GTFS zip file (if not using --city)')
    args = parser.parse_args()
    
    # Determine GTFS files and output directory
    if args.city:
        city_dir = args.city
        output_dir = args.city
        gtfs_paths = find_gtfs_files(city_dir)
        if not gtfs_paths:
            print(f"Error: No .zip GTFS files found in '{city_dir}' directory")
            return 1
        print(f"Found {len(gtfs_paths)} GTFS file(s) in {city_dir}: {', '.join(Path(p).name for p in gtfs_paths)}")
    else:
        output_dir = args.output_dir
        if args.gtfs_path:
            gtfs_paths = [args.gtfs_path]
        else:
            gtfs_paths = find_gtfs_files(output_dir)
            if not gtfs_paths:
                print(f"Error: No .zip GTFS files found in '{output_dir}' directory and --gtfs-path not provided")
                return 1
    
    # Create output directory if it doesn't exist
    os.makedirs(output_dir, exist_ok=True)
    
    # Load city-specific utils if available
    city_utils = load_city_utils(output_dir) if args.city else None
    
    # Load all GTFS data once
    print("Loading GTFS data...")
    if len(gtfs_paths) > 1:
        print(f"Merging data from {len(gtfs_paths)} GTFS files...")
    gtfs_data = load_gtfs_data_from_multiple_files(gtfs_paths, include_shapes=True)
    
    # Calculate valid routes once
    print("Filtering valid routes...")
    valid_routes = get_valid_routes(gtfs_data, args.min_trips)
    print(f"Found {len(valid_routes):,} valid routes")
    
    # Process and save stops
    print("Processing stops...")
    stops_dict = process_stops(gtfs_data, valid_routes)
    print(f"Found {len(stops_dict):,} stops")
    
    # Apply city-specific stop name processing
    stops_dict = apply_city_stop_processing(stops_dict, gtfs_data, valid_routes, city_utils)
    
    # Sort keys to ensure consistent output order
    stops_dict_sorted = dict(sorted(stops_dict.items()))
    with open(os.path.join(output_dir, 'stops.min.json'), 'w') as f:
        json.dump(stops_dict_sorted, f, separators=(',', ':'))
    
    # Process and save routes
    print("Processing routes...")
    routes_dict = process_routes(gtfs_data, valid_routes)
    print(f"Generated routes for {len(routes_dict):,} route IDs")
    # Sort keys to ensure consistent output order
    routes_dict_sorted = dict(sorted(routes_dict.items()))
    with open(os.path.join(output_dir, 'routes.min.json'), 'w') as f:
        json.dump(routes_dict_sorted, f, separators=(',', ':'))
    
    # Process and save services
    print("Processing services...")
    services_dict = process_services(gtfs_data, valid_routes)
    print(f"Generated services for {len(services_dict):,} routes")
    # Sort keys to ensure consistent output order (both outer and inner keys)
    services_dict_sorted = {}
    for route_id in sorted(services_dict.keys()):
        route_data = services_dict[route_id]
        # Sort inner keys (name should come first, then destinations)
        sorted_route_data = {}
        if 'name' in route_data:
            sorted_route_data['name'] = route_data['name']
        # Add destination keys in sorted order
        for dest_key in sorted([k for k in route_data.keys() if k != 'name']):
            sorted_route_data[dest_key] = route_data[dest_key]
        services_dict_sorted[route_id] = sorted_route_data
    with open(os.path.join(output_dir, 'services.min.json'), 'w') as f:
        json.dump(services_dict_sorted, f, separators=(',', ':'))
    
    # Apply city-specific mapping generation if available
    apply_city_mapping_generation(gtfs_data, output_dir, city_utils)

    print("\n✓ Completed! Generated all JSON files")

if __name__ == '__main__':
    main()
