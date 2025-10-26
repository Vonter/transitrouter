#!/usr/bin/env python3
import json
import zipfile
import pandas as pd
import polyline
import argparse
from typing import Dict, List, Tuple
from collections import defaultdict

# Default minimum number of trips per day for a route to be included
DEFAULT_MIN_TRIPS = 2

def has_shapes_file(zip_path: str) -> bool:
    """Check if the GTFS zip contains shapes.txt."""
    with zipfile.ZipFile(zip_path) as z:
        return 'shapes.txt' in z.namelist()

def has_direction_id(trips_df: pd.DataFrame) -> bool:
    """Check if trips.txt contains direction_id column."""
    return 'direction_id' in trips_df.columns

def get_direction_id(trip: pd.Series, trips_has_direction: bool, routes_df: pd.DataFrame) -> str:
    """Get direction_id from trip, handling cases where it doesn't exist."""
    if not trips_has_direction:
        # When direction_id doesn't exist, use UP/DOWN in route_long_name
        route_info = routes_df[routes_df['route_id'] == trip['route_id']].iloc[0]
        route_name = str(route_info['route_long_name']).upper()
        
        # Check for UP/DOWN in the route name
        if 'UP' in route_name:
            return "0"
        elif 'DOWN' in route_name:
            return "1"
        else:
            return "0"  # Default to "0" if no direction can be determined
            
    return str(trip['direction_id'] if pd.notna(trip['direction_id']) else "0")

def read_gtfs_file(zip_path: str, filename: str) -> pd.DataFrame:
    """Read a GTFS file from the zip archive into a pandas DataFrame."""
    with zipfile.ZipFile(zip_path) as z:
        return pd.read_csv(z.open(filename))

def encode_polyline(coordinates: List[Tuple[float, float]]) -> str:
    """Encode a list of coordinates into a polyline string."""
    return polyline.encode([(lat, lon) for lat, lon in coordinates])

def generate_mock_shapes(gtfs_path: str, route_id: str, direction: str) -> List[Tuple[float, float]]:
    """Generate mock shapes by connecting stops with straight lines."""
    trips_df = read_gtfs_file(gtfs_path, 'trips.txt')
    stop_times_df = read_gtfs_file(gtfs_path, 'stop_times.txt')
    stops_df = read_gtfs_file(gtfs_path, 'stops.txt')
    routes_df = read_gtfs_file(gtfs_path, 'routes.txt')
    trips_has_direction = has_direction_id(trips_df)
    
    # Get a representative trip for this route and direction
    route_trips = trips_df[trips_df['route_id'] == route_id]
    if trips_has_direction:
        route_trips = route_trips[
            route_trips['direction_id'].astype(str).fillna("0") == direction
        ]
    else:
        # When no direction_id, use UP/DOWN from route name
        route_trips = route_trips[
            route_trips.apply(
                lambda trip: get_direction_id(trip, trips_has_direction, routes_df) == direction,
                axis=1
            )
        ]
    
    if len(route_trips) == 0:
        return []
    
    trip_id = route_trips.iloc[0]['trip_id']
    
    # Get ordered stop sequence for this trip
    trip_stops = stop_times_df[stop_times_df['trip_id'] == trip_id].sort_values('stop_sequence')
    stop_ids = trip_stops['stop_id'].tolist()
    
    # Get coordinates for each stop
    coordinates = []
    for stop_id in stop_ids:
        stop_info = stops_df[stops_df['stop_id'] == stop_id].iloc[0]
        coordinates.append((float(stop_info['stop_lat']), float(stop_info['stop_lon'])))
    
    return coordinates

def count_trips_per_route(gtfs_path: str) -> Dict[str, Dict[str, int]]:
    """Count the number of trips per route and direction."""
    trips_df = read_gtfs_file(gtfs_path, 'trips.txt')
    routes_df = read_gtfs_file(gtfs_path, 'routes.txt')
    trips_has_direction = has_direction_id(trips_df)
    
    # Initialize a defaultdict to store counts
    trip_counts = defaultdict(lambda: {"0": 0, "1": 0})
    
    # Count trips for each route and direction
    for _, trip in trips_df.iterrows():
        route_id = trip['route_id']
        direction = get_direction_id(trip, trips_has_direction, routes_df)
        trip_counts[route_id][direction] += 1
    
    return dict(trip_counts)

def process_stops(gtfs_path: str) -> Dict:
    """Process stops.txt and generate stops.min.json format."""
    stops_df = read_gtfs_file(gtfs_path, 'stops.txt')
    stops_dict = {}
    
    for _, row in stops_df.iterrows():
        stops_dict[row['stop_id']] = [
            float(row['stop_lon']),  # longitude first
            float(row['stop_lat']),  # latitude second
            row['stop_name'],
            ""  # blank string as required
        ]
    
    return stops_dict

def process_routes(gtfs_path: str, min_trips: int = DEFAULT_MIN_TRIPS) -> Dict:
    """Process shapes.txt (or generate mock shapes) and routes.txt to generate routes.min.json format."""
    trips_df = read_gtfs_file(gtfs_path, 'trips.txt')
    trips_has_direction = has_direction_id(trips_df)
    
    # Get trip counts and filter routes
    trip_counts = count_trips_per_route(gtfs_path)
    valid_routes = {
        route_id for route_id, counts in trip_counts.items()
        if counts["0"] >= min_trips or counts["1"] >= min_trips
    }
    
    # Filter trips to only include valid routes
    trips_df = trips_df[trips_df['route_id'].isin(valid_routes)]
    
    routes_dict = defaultdict(list)
    
    if has_shapes_file(gtfs_path):
        # Use actual shapes if available
        shapes_df = read_gtfs_file(gtfs_path, 'shapes.txt')
        shapes_df = shapes_df.sort_values(['shape_id', 'shape_pt_sequence'])
        
        # Select columns based on availability of direction_id
        route_shape_cols = ['route_id', 'shape_id']
        if trips_has_direction:
            route_shape_cols.append('direction_id')
        route_shapes = trips_df[route_shape_cols].drop_duplicates()
        
        # Process each shape
        for shape_id in shapes_df['shape_id'].unique():
            shape_points = shapes_df[shapes_df['shape_id'] == shape_id]
            coordinates = list(zip(shape_points['shape_pt_lat'], shape_points['shape_pt_lon']))
            
            # Find associated routes and directions
            route_dirs = route_shapes[route_shapes['shape_id'] == shape_id]
            for _, row in route_dirs.iterrows():
                routes_dict[row['route_id']].append(encode_polyline(coordinates))
    else:
        # Generate mock shapes by connecting stops
        for route_id in valid_routes:
            # Process each direction
            for direction in ["0", "1"]:
                coordinates = generate_mock_shapes(gtfs_path, route_id, direction)
                if coordinates:
                    routes_dict[route_id].append(encode_polyline(coordinates))
    
    return dict(routes_dict)

def process_services(gtfs_path: str, min_trips: int = DEFAULT_MIN_TRIPS) -> Dict:
    """Process trips.txt and stop_times.txt to generate services.min.json format."""
    routes_df = read_gtfs_file(gtfs_path, 'routes.txt')
    trips_df = read_gtfs_file(gtfs_path, 'trips.txt')
    stop_times_df = read_gtfs_file(gtfs_path, 'stop_times.txt')
    trips_has_direction = has_direction_id(trips_df)
    
    # Get trip counts and filter routes
    trip_counts = count_trips_per_route(gtfs_path)
    valid_routes = {
        route_id for route_id, counts in trip_counts.items()
        if counts["0"] >= min_trips or counts["1"] >= min_trips
    }
    
    # Filter routes and trips to only include valid routes
    routes_df = routes_df[routes_df['route_id'].isin(valid_routes)]
    trips_df = trips_df[trips_df['route_id'].isin(valid_routes)]
    
    # Sort stop times by sequence
    stop_times_df = stop_times_df.sort_values(['trip_id', 'stop_sequence'])
    
    services_dict = {}
    
    for _, route in routes_df.iterrows():
        route_id = route['route_id']
        route_trips = trips_df[trips_df['route_id'] == route_id]
        
        # Initialize route entry
        services_dict[route_id] = {
            "name": route['route_long_name'],
            "routes": []
        }
        
        # Process each direction
        for direction in ["0", "1"]:
            if trips_has_direction:
                dir_trips = route_trips[
                    route_trips['direction_id'].astype(str).fillna("0") == direction
                ]
            else:
                # When no direction_id, use UP/DOWN from route name
                dir_trips = route_trips.apply(
                    lambda trip: get_direction_id(trip, trips_has_direction, routes_df) == direction,
                    axis=1
                )
                dir_trips = route_trips[dir_trips]
            
            if len(dir_trips) > 0:
                # Take the first trip as representative
                first_trip = dir_trips.iloc[0]
                trip_stops = stop_times_df[
                    stop_times_df['trip_id'] == first_trip['trip_id']
                ]
                services_dict[route_id]["routes"].append(trip_stops['stop_id'].tolist())
    
    return services_dict

def main():
    """Main function to process GTFS and generate JSON files."""
    parser = argparse.ArgumentParser(description='Process GTFS data with minimum trips filter')
    parser.add_argument('--min-trips', type=int, default=DEFAULT_MIN_TRIPS,
                      help=f'Minimum number of trips per day for a route to be included (default: {DEFAULT_MIN_TRIPS})')
    parser.add_argument('--gtfs-path', type=str, default='bmtc.zip',
                      help='Path to the GTFS zip file (default: bmtc.zip)')
    args = parser.parse_args()
    
    # Process stops
    stops_dict = process_stops(args.gtfs_path)
    with open('stops.min.json', 'w') as f:
        json.dump(stops_dict, f, separators=(',', ':'))
    
    # Process routes
    routes_dict = process_routes(args.gtfs_path, args.min_trips)
    with open('routes.min.json', 'w') as f:
        json.dump(routes_dict, f, separators=(',', ':'))
    
    # Process services
    services_dict = process_services(args.gtfs_path, args.min_trips)
    with open('services.min.json', 'w') as f:
        json.dump(services_dict, f, separators=(',', ':'))

if __name__ == '__main__':
    main()
