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

def read_gtfs_file(zip_path: str, filename: str) -> pd.DataFrame:
    """Read a GTFS file from the zip archive into a pandas DataFrame."""
    with zipfile.ZipFile(zip_path) as z:
        return pd.read_csv(z.open(filename))

def encode_polyline(coordinates: List[Tuple[float, float]]) -> str:
    """Encode a list of coordinates into a polyline string."""
    return polyline.encode([(lat, lon) for lat, lon in coordinates])

def count_trips_per_route(gtfs_path: str) -> Dict[str, Dict[str, int]]:
    """Count the number of trips per route and direction."""
    trips_df = read_gtfs_file(gtfs_path, 'trips.txt')
    
    # Initialize a defaultdict to store counts
    trip_counts = defaultdict(lambda: {"0": 0, "1": 0})
    
    # Count trips for each route and direction
    for _, trip in trips_df.iterrows():
        route_id = trip['route_id']
        direction = str(trip['direction_id'] if pd.notna(trip['direction_id']) else "0")
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
    """Process shapes.txt and routes.txt to generate routes.min.json format."""
    shapes_df = read_gtfs_file(gtfs_path, 'shapes.txt')
    trips_df = read_gtfs_file(gtfs_path, 'trips.txt')
    
    # Get trip counts and filter routes
    trip_counts = count_trips_per_route(gtfs_path)
    valid_routes = {
        route_id for route_id, counts in trip_counts.items()
        if counts["0"] >= min_trips or counts["1"] >= min_trips
    }
    
    # Filter trips to only include valid routes
    trips_df = trips_df[trips_df['route_id'].isin(valid_routes)]
    
    # Sort shapes by sequence
    shapes_df = shapes_df.sort_values(['shape_id', 'shape_pt_sequence'])
    
    # Get route to shape mapping
    route_shapes = trips_df[['route_id', 'shape_id', 'direction_id']].drop_duplicates()
    
    routes_dict = defaultdict(lambda: {"0": [], "1": []})
    
    # Process each shape
    for shape_id in shapes_df['shape_id'].unique():
        shape_points = shapes_df[shapes_df['shape_id'] == shape_id]
        coordinates = list(zip(shape_points['shape_pt_lat'], shape_points['shape_pt_lon']))
        
        # Find associated routes and directions
        route_dirs = route_shapes[route_shapes['shape_id'] == shape_id]
        for _, row in route_dirs.iterrows():
            direction = str(row['direction_id'] if pd.notna(row['direction_id']) else "0")
            if row['route_id'] not in routes_dict:
                routes_dict[row['route_id']] = []
            routes_dict[row['route_id']].append(encode_polyline(coordinates))
    
    return dict(routes_dict)

def process_services(gtfs_path: str, min_trips: int = DEFAULT_MIN_TRIPS) -> Dict:
    """Process trips.txt and stop_times.txt to generate services.min.json format."""
    routes_df = read_gtfs_file(gtfs_path, 'routes.txt')
    trips_df = read_gtfs_file(gtfs_path, 'trips.txt')
    stop_times_df = read_gtfs_file(gtfs_path, 'stop_times.txt')
    
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
            dir_trips = route_trips[
                route_trips['direction_id'].astype(str).fillna("0") == direction
            ]
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
