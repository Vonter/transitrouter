#!/usr/bin/env python3
import json
import zipfile
import polars as pl
import polyline
import argparse
import os
from typing import Dict, List, Tuple, Set
from collections import defaultdict

# Default minimum number of trips per day for a route to be included
DEFAULT_MIN_TRIPS = 2

def read_gtfs_file(zip_path: str, filename: str) -> pl.DataFrame:
    """Read a GTFS file from the zip archive into a polars DataFrame."""
    with zipfile.ZipFile(zip_path) as z:
        return pl.read_csv(z.open(filename))

def load_gtfs_data(gtfs_path: str) -> Dict[str, pl.DataFrame]:
    """Load all necessary GTFS files into memory once."""
    data = {
        'routes': read_gtfs_file(gtfs_path, 'routes.txt'),
        'trips': read_gtfs_file(gtfs_path, 'trips.txt'),
        'stop_times': read_gtfs_file(gtfs_path, 'stop_times.txt'),
        'stops': read_gtfs_file(gtfs_path, 'stops.txt'),
    }
    
    # Check for shapes file
    with zipfile.ZipFile(gtfs_path) as z:
        if 'shapes.txt' in z.namelist():
            data['shapes'] = read_gtfs_file(gtfs_path, 'shapes.txt').sort(['shape_id', 'shape_pt_sequence'])
    
    return data

def get_valid_routes(gtfs_data: Dict[str, pl.DataFrame], min_trips: int) -> Set[str]:
    """Get routes that have at least min_trips in at least one direction."""
    trips_df = gtfs_data['trips']
    routes_df = gtfs_data['routes']
    has_direction = 'direction_id' in trips_df.columns
    
    # Normalize direction_id
    trips_df = trips_df.clone()
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
        )
        trips_df = trips_df.with_columns(
            pl.col('route_long_name').str.to_uppercase().alias('route_upper')
        )
        trips_df = trips_df.with_columns(
            pl.when(pl.col('route_upper').str.contains('UP'))
            .then(pl.lit("0"))
            .when(pl.col('route_upper').str.contains('DOWN'))
            .then(pl.lit("1"))
            .otherwise(pl.lit("0"))
            .alias('direction')
        )
    
    # Count trips per route and direction
    trip_counts = trips_df.group_by(['route_id', 'direction']).agg(
        pl.count().alias('count')
    ).pivot(
        values='count',
        index='route_id',
        columns='direction',
        aggregate_function='first'
    ).fill_null(0)
    
    # Return routes with at least min_trips in any direction
    valid_routes = set()
    for row in trip_counts.iter_rows(named=True):
        route_id = row['route_id']
        # Check all direction columns (excluding route_id)
        counts = [v for k, v in row.items() if k != 'route_id']
        if any(c >= min_trips for c in counts):
            valid_routes.add(route_id)
    
    return valid_routes

def process_stops(gtfs_data: Dict[str, pl.DataFrame], valid_routes: Set[str]) -> Dict:
    """Process stops.txt and generate stops.min.json format, filtering out stops with no valid routes."""
    stops_df = gtfs_data['stops']
    trips_df = gtfs_data['trips'].filter(pl.col('route_id').is_in(list(valid_routes)))
    stop_times_df = gtfs_data['stop_times']
    
    # Get stops served by valid routes
    valid_trip_ids = trips_df['trip_id'].to_list()
    valid_stop_ids = set(
        stop_times_df.filter(pl.col('trip_id').is_in(valid_trip_ids))['stop_id'].unique().to_list()
    )
    
    # Filter and convert to dictionary
    valid_stops = stops_df.filter(pl.col('stop_id').is_in(list(valid_stop_ids)))
    return {
        row['stop_id']: [float(row['stop_lon']), float(row['stop_lat']), row['stop_name'], ""]
        for row in valid_stops.iter_rows(named=True)
    }

def encode_polyline(coordinates: List[Tuple[float, float]]) -> str:
    """Encode a list of coordinates into a polyline string."""
    return polyline.encode([(lat, lon) for lat, lon in coordinates])

def generate_mock_shape(gtfs_data: Dict[str, pl.DataFrame], route_id: str, direction: str) -> List[Tuple[float, float]]:
    """Generate mock shapes by connecting stops with straight lines."""
    trips_df = gtfs_data['trips']
    stop_times_df = gtfs_data['stop_times']
    stops_df = gtfs_data['stops']
    has_direction = 'direction_id' in trips_df.columns
    
    # Filter trips for route and direction
    route_trips = trips_df.filter(pl.col('route_id') == route_id).clone()
    if has_direction:
        route_trips = route_trips.filter(
            pl.col('direction_id').fill_null(0).cast(pl.Utf8) == direction
        )
    else:
        routes_df = gtfs_data['routes']
        route_trips = route_trips.join(
            routes_df.select(['route_id', 'route_long_name']), 
            on='route_id', 
            how='left'
        )
        route_trips = route_trips.with_columns(
            pl.col('route_long_name').str.to_uppercase().alias('route_upper')
        )
        if direction == "0":
            route_trips = route_trips.filter(
                pl.col('route_upper').str.contains('UP') | 
                ~pl.col('route_upper').str.contains('DOWN')
            )
        else:
            route_trips = route_trips.filter(
                pl.col('route_upper').str.contains('DOWN')
            )
    
    if len(route_trips) == 0:
        return []
    
    # Get stops for first trip
    trip_id = route_trips.row(0, named=True)['trip_id']
    trip_stops = stop_times_df.filter(pl.col('trip_id') == trip_id).sort('stop_sequence')
    
    # Join with stops to get coordinates
    trip_stops = trip_stops.join(
        stops_df.select(['stop_id', 'stop_lat', 'stop_lon']), 
        on='stop_id', 
        how='left'
    )
    return [(float(row['stop_lat']), float(row['stop_lon'])) for row in trip_stops.iter_rows(named=True)]

def process_routes(gtfs_data: Dict[str, pl.DataFrame], valid_routes: Set[str]) -> Dict:
    """Process shapes.txt (or generate mock shapes) and routes.txt to generate routes.min.json format."""
    trips_df = gtfs_data['trips'].filter(pl.col('route_id').is_in(list(valid_routes)))
    routes_dict = defaultdict(list)
    
    # Check if both shapes.txt exists AND trips have shape_id column
    if 'shapes' in gtfs_data and 'shape_id' in trips_df.columns:
        shapes_df = gtfs_data['shapes']
        has_direction = 'direction_id' in trips_df.columns
        
        # Get unique route-shape mappings
        cols = ['route_id', 'shape_id'] + (['direction_id'] if has_direction else [])
        route_shapes = trips_df.select(cols).unique()
        
        # Process each unique shape
        for shape_id in shapes_df['shape_id'].unique().to_list():
            shape_points = shapes_df.filter(pl.col('shape_id') == shape_id)
            coordinates = list(zip(
                shape_points['shape_pt_lat'].to_list(),
                shape_points['shape_pt_lon'].to_list()
            ))
            encoded = encode_polyline(coordinates)
            
            # Add to all routes using this shape
            for route_id in route_shapes.filter(pl.col('shape_id') == shape_id)['route_id'].unique().to_list():
                routes_dict[route_id].append(encoded)
    else:
        # Generate mock shapes
        for route_id in valid_routes:
            for direction in ["0", "1"]:
                coordinates = generate_mock_shape(gtfs_data, route_id, direction)
                if coordinates:
                    routes_dict[route_id].append(encode_polyline(coordinates))
    
    return dict(routes_dict)

def process_services(gtfs_data: Dict[str, pl.DataFrame], valid_routes: Set[str]) -> Dict:
    """Process trips.txt and stop_times.txt to generate services.min.json format with destination grouping."""
    routes_df = gtfs_data['routes'].filter(pl.col('route_id').is_in(list(valid_routes)))
    trips_df = gtfs_data['trips'].filter(pl.col('route_id').is_in(list(valid_routes)))
    stop_times_df = gtfs_data['stop_times'].sort(['trip_id', 'stop_sequence'])
    has_direction = 'direction_id' in trips_df.columns
    
    services_dict = {}
    
    for route in routes_df.iter_rows(named=True):
        route_id = route['route_id']
        route_trips = trips_df.filter(pl.col('route_id') == route_id)
        
        # Dictionary to group by destination: {destination_stop_id: {'routes': [route_arrays], 'trip_ids': set()}}
        destination_groups = defaultdict(lambda: {'routes_map': {}, 'trip_ids': set()})
        
        # Process each direction
        for direction in ["0", "1"]:
            if has_direction:
                dir_trips = route_trips.filter(
                    pl.col('direction_id').fill_null(0).cast(pl.Utf8) == direction
                )
            else:
                route_upper = str(route['route_long_name']).upper()
                if direction == "0":
                    dir_trips = route_trips if 'UP' in route_upper or 'DOWN' not in route_upper else route_trips.head(0)
                else:
                    dir_trips = route_trips if 'DOWN' in route_upper else route_trips.head(0)
            
            # Group trips by destination (last stop)
            for trip in dir_trips.iter_rows(named=True):
                trip_id = trip['trip_id']
                trip_stops = stop_times_df.filter(pl.col('trip_id') == trip_id).sort('stop_sequence')
                
                if len(trip_stops) > 0:
                    stops_list = trip_stops['stop_id'].to_list()
                    destination = stops_list[-1]  # Last stop is destination
                    
                    # Convert stops_list to tuple for use as dict key
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
        services_dict[route_id] = {
            "name": route['route_long_name']
        }
        # Add destinations directly (not nested under "routes" key)
        for dest, data in sorted_destinations:
            services_dict[route_id][dest] = data['routes']
    
    return services_dict

def main():
    """Main function to process GTFS and generate JSON files."""
    parser = argparse.ArgumentParser(description='Process GTFS data with minimum trips filter')
    parser.add_argument('--min-trips', type=int, default=DEFAULT_MIN_TRIPS,
                      help=f'Minimum number of trips per day for a route to be included (default: {DEFAULT_MIN_TRIPS})')
    parser.add_argument('--output-dir', type=str, default='.',
                      help='Output directory for JSON files (default: current directory)')
    parser.add_argument('--city', type=str,
                      help='City name (if provided, output will go to $city/)')
    args = parser.parse_args()
    
    # Determine output directory
    if args.city:
        output_dir = args.city
        gtfs_path = os.path.join(args.city, 'gtfs.zip') 
    else:
        output_dir = args.output_dir
        gtfs_path = os.path.join(args.output_dir, 'gtfs.zip')
    
    # Create output directory if it doesn't exist
    os.makedirs(output_dir, exist_ok=True)
    
    # Load all GTFS data once
    gtfs_data = load_gtfs_data(gtfs_path)
    
    # Calculate valid routes once
    valid_routes = get_valid_routes(gtfs_data, args.min_trips)
    
    # Process and save stops
    stops_dict = process_stops(gtfs_data, valid_routes)
    with open(os.path.join(output_dir, 'stops.min.json'), 'w') as f:
        json.dump(stops_dict, f, separators=(',', ':'))
    
    # Process and save routes
    routes_dict = process_routes(gtfs_data, valid_routes)
    with open(os.path.join(output_dir, 'routes.min.json'), 'w') as f:
        json.dump(routes_dict, f, separators=(',', ':'))
    
    # Process and save services
    services_dict = process_services(gtfs_data, valid_routes)
    with open(os.path.join(output_dir, 'services.min.json'), 'w') as f:
        json.dump(services_dict, f, separators=(',', ':'))

if __name__ == '__main__':
    main()
