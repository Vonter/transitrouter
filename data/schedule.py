#!/usr/bin/env python3
import json
import zipfile
import polars as pl
import argparse
import os
from typing import Dict, List, Tuple, Optional
from collections import defaultdict

# Default minimum number of trips per day for a route to be included
DEFAULT_MIN_TRIPS = 2

def read_gtfs_file(zip_path: str, filename: str) -> pl.DataFrame:
    """Read a GTFS file from the zip archive into a polars DataFrame."""
    with zipfile.ZipFile(zip_path) as z:
        return pl.read_csv(z.open(filename))


def has_direction_id(trips_df: pl.DataFrame) -> bool:
    """Check if trips.txt contains direction_id column."""
    return 'direction_id' in trips_df.columns


def build_route_lookup(routes_df: pl.DataFrame) -> Dict[str, str]:
    """Build a dictionary mapping route_id to route_long_name for fast lookup."""
    routes_with_names = routes_df.select([
        'route_id',
        pl.col('route_long_name').fill_null('').cast(pl.Utf8).str.to_uppercase()
    ])
    return dict(zip(
        routes_with_names['route_id'].to_list(),
        routes_with_names['route_long_name'].to_list()
    ))


def compute_directions_from_names(trips_df: pl.DataFrame, route_lookup: Dict[str, str]) -> List[str]:
    """Compute direction_id from route names containing UP/DOWN."""
    def get_direction(route_id):
        route_name = route_lookup.get(route_id, '')
        if 'UP' in route_name:
            return "0"
        elif 'DOWN' in route_name:
            return "1"
        return "0"
    
    return [get_direction(rid) for rid in trips_df['route_id'].to_list()]


def prepare_trips_with_directions(trips_df: pl.DataFrame, routes_df: pl.DataFrame) -> pl.DataFrame:
    """Add standardized direction_id column to trips dataframe."""
    trips_df = trips_df.clone()
    
    if has_direction_id(trips_df):
        # Standardize existing direction_id
        trips_df = trips_df.with_columns(
            pl.col('direction_id').fill_null("0").cast(pl.Utf8).alias('direction')
        )
    else:
        # Compute direction from route names
        route_lookup = build_route_lookup(routes_df)
        directions = compute_directions_from_names(trips_df, route_lookup)
        trips_df = trips_df.with_columns(
            pl.Series('direction', directions)
        )
    
    return trips_df


def count_trips_per_route(trips_df: pl.DataFrame) -> Dict[str, Dict[str, int]]:
    """Count the number of trips per route and direction using vectorized operations."""
    # Group by route_id and direction, then count
    counts = trips_df.group_by(['route_id', 'direction']).agg(
        pl.count().alias('count')
    )
    
    # Convert to nested dictionary
    trip_counts = defaultdict(lambda: {"0": 0, "1": 0})
    for row in counts.iter_rows(named=True):
        trip_counts[row['route_id']][row['direction']] = row['count']
    
    return dict(trip_counts)


def format_time(time_str: str) -> str:
    """Format time from HH:MM:SS to HH:MM, handling times >= 24:00:00."""
    try:
        parts = time_str.split(':')
        hours = int(parts[0])
        minutes = int(parts[1])
        
        # Handle times >= 24:00:00 (next day times in GTFS)
        if hours >= 24:
            hours = hours % 24
            
        return f"{hours:02d}:{minutes:02d}"
    except (ValueError, IndexError, AttributeError):
        return str(time_str)


def get_route_endpoints_batch(trips_df: pl.DataFrame, stop_times_df: pl.DataFrame) -> Dict[Tuple[str, str], Tuple[str, str]]:
    """Get origin and destination for all route-direction combinations in batch."""
    endpoints = {}
    
    # Get one representative trip per route-direction
    representative_trips = trips_df.group_by(['route_id', 'direction']).agg(
        pl.col('trip_id').first()
    )
    
    # Get all stop times for these representative trips
    rep_trip_ids = set(representative_trips['trip_id'].to_list())
    rep_stop_times = stop_times_df.filter(pl.col('trip_id').is_in(list(rep_trip_ids))).clone()
    
    # Sort by stop_sequence to get first and last stops
    rep_stop_times = rep_stop_times.sort('stop_sequence')
    
    # Group by trip_id and get first and last stop_id
    first_stops = rep_stop_times.group_by('trip_id').agg(
        pl.col('stop_id').first().alias('first_stop')
    )
    last_stops = rep_stop_times.group_by('trip_id').agg(
        pl.col('stop_id').last().alias('last_stop')
    )
    
    # Join first and last stops
    stops_combined = first_stops.join(last_stops, on='trip_id', how='inner')
    stops_dict = {
        row['trip_id']: (str(row['first_stop']), str(row['last_stop']))
        for row in stops_combined.iter_rows(named=True)
    }
    
    # Map back to route_id and direction
    for row in representative_trips.iter_rows(named=True):
        trip_id = row['trip_id']
        if trip_id in stops_dict:
            key = (row['route_id'], row['direction'])
            endpoints[key] = stops_dict[trip_id]
    
    return endpoints


def process_schedules(gtfs_path: str, output_dir: str, min_trips: int = DEFAULT_MIN_TRIPS):
    """Process GTFS data and generate schedule JSON files for each stop."""
    
    # Read GTFS files
    print("Reading GTFS files...")
    routes_df = read_gtfs_file(gtfs_path, 'routes.txt')
    trips_df = read_gtfs_file(gtfs_path, 'trips.txt')
    stop_times_df = read_gtfs_file(gtfs_path, 'stop_times.txt')
    
    # Prepare trips with standardized directions
    print("Processing trip directions...")
    trips_df = prepare_trips_with_directions(trips_df, routes_df)
    
    # Filter routes by minimum trips
    print("Filtering routes by minimum trips...")
    trip_counts = count_trips_per_route(trips_df)
    valid_routes = {
        route_id for route_id, counts in trip_counts.items()
        if counts["0"] >= min_trips or counts["1"] >= min_trips
    }
    
    print(f"Found {len(valid_routes)} valid routes out of {len(routes_df)} total routes")
    
    # Filter to only valid routes
    routes_df = routes_df.filter(pl.col('route_id').is_in(list(valid_routes))).clone()
    trips_df = trips_df.filter(pl.col('route_id').is_in(list(valid_routes))).clone()
    
    # Get route endpoints in batch
    print("Computing route endpoints...")
    endpoints = get_route_endpoints_batch(trips_df, stop_times_df)
    
    # Create output directory
    os.makedirs(output_dir, exist_ok=True)
    
    # Build trip_id to route+direction mapping for fast lookup
    print("Building trip lookup table...")
    trip_lookup = {}
    for row in trips_df.select(['trip_id', 'route_id', 'direction']).iter_rows(named=True):
        trip_lookup[row['trip_id']] = {
            'route_id': row['route_id'],
            'direction': row['direction']
        }
    
    # Filter stop_times to only include trips from valid routes
    print("Filtering stop times...")
    valid_trip_ids = set(trips_df['trip_id'].to_list())
    stop_times_df = stop_times_df.filter(pl.col('trip_id').is_in(list(valid_trip_ids))).clone()
    
    # Process stop times - use iter_rows for better performance
    print("Processing stop times...")
    stop_data = defaultdict(lambda: defaultdict(lambda: {
        'origin': '',
        'destination': '',
        'trips': []
    }))
    
    total_entries = len(stop_times_df)
    for i, row in enumerate(stop_times_df.iter_rows(named=True), 1):
        if i % 50000 == 0:
            print(f"Processing entry {i:,}/{total_entries:,} ({100*i/total_entries:.1f}%)...")
        
        # Get arrival time (or departure if arrival is missing)
        arrival_time = row.get('arrival_time')
        if arrival_time is None:
            arrival_time = row.get('departure_time')
        
        if not arrival_time:
            continue
        
        # Fast lookup using pre-built dictionary
        trip_info = trip_lookup.get(row['trip_id'])
        if not trip_info:
            continue
        
        route_id = trip_info['route_id']
        direction = trip_info['direction']
        
        # Format time and store
        formatted_time = format_time(str(arrival_time))
        stop_id = str(row['stop_id'])
        route_dir_key = f"{route_id}_{direction}"
        
        stop_data[stop_id][route_dir_key]['trips'].append(formatted_time)
    
    # Add endpoints to stop data
    print("Adding route endpoints to stop data...")
    for stop_id in stop_data:
        for route_dir_key in stop_data[stop_id]:
            route_id, direction = route_dir_key.split('_', 1)
            origin, destination = endpoints.get((route_id, direction), ('', ''))
            stop_data[stop_id][route_dir_key]['origin'] = origin
            stop_data[stop_id][route_dir_key]['destination'] = destination
    
    # Write JSON files for each stop
    print("Writing JSON files...")
    total_stops = len(stop_data)
    
    for i, (stop_id, routes_data) in enumerate(stop_data.items(), 1):
        services = []
        
        for route_dir_key, data in routes_data.items():
            route_id, direction = route_dir_key.split('_', 1)
            
            # Sort trips chronologically
            sorted_trips = sorted(set(data['trips']))  # Remove duplicates and sort
            
            services.append({
                "no": route_id,
                "origin": data['origin'],
                "destination": data['destination'],
                "trips": sorted_trips,
                "trip_count": len(sorted_trips)
            })
        
        # Sort services by route number (natural sort if possible)
        try:
            services.sort(key=lambda x: (int(x['no']) if x['no'].isdigit() else float('inf'), x['no']))
        except (ValueError, TypeError):
            services.sort(key=lambda x: x['no'])
        
        # Write JSON file
        output_file = os.path.join(output_dir, f"{stop_id}.json")
        with open(output_file, 'w') as f:
            json.dump({"services": services}, f, separators=(',', ':'))
        
        if i % 100 == 0:
            print(f"Written {i:,}/{total_stops:,} stop files ({100*i/total_stops:.1f}%)...")
    
    print(f"\n✓ Completed! Generated {total_stops:,} schedule files in {output_dir}")


def main():
    """Main function to process GTFS and generate schedule JSON files."""
    parser = argparse.ArgumentParser(
        description='Process GTFS data to generate per-stop schedule files',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    parser.add_argument(
        '--min-trips', 
        type=int, 
        default=DEFAULT_MIN_TRIPS,
        help='Minimum number of trips per day for a route to be included'
    )
    parser.add_argument(
        '--gtfs-path', 
        type=str, 
        default='bmtc.zip',
        help='Path to the GTFS zip file'
    )
    parser.add_argument(
        '--output-dir',
        type=str,
        default='schedule',
        help='Output directory for schedule JSON files'
    )
    parser.add_argument(
        '--city',
        type=str,
        help='City name (if provided, output will go to $city/schedule/)'
    )
    
    args = parser.parse_args()
    
    # Determine output directory
    if args.city:
        output_dir = os.path.join(args.city, 'schedule')
    else:
        output_dir = args.output_dir
    
    # Process schedules
    try:
        process_schedules(args.gtfs_path, output_dir, args.min_trips)
    except FileNotFoundError as e:
        print(f"Error: Could not find file: {e}")
        return 1
    except Exception as e:
        print(f"Error processing GTFS data: {e}")
        import traceback
        traceback.print_exc()
        return 1
    
    return 0


if __name__ == '__main__':
    exit(main())
