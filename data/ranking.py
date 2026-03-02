#!/usr/bin/env python3
import json
import polars as pl
import argparse
import os
import math
from pathlib import Path
from typing import Dict, List, Set, Tuple
from collections import defaultdict

from utils import (
    read_gtfs_file,
    find_gtfs_files,
    load_gtfs_data_from_multiple_files
)

# Default minimum number of trips per day for a route to be included
DEFAULT_MIN_TRIPS = 2
# Default radius in meters for finding neighboring stops
DEFAULT_NEIGHBOR_RADIUS = 250


def get_valid_routes(trips_df: pl.DataFrame, routes_df: pl.DataFrame, min_trips: int) -> Set[str]:
    """Get routes that have at least min_trips in at least one direction."""
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
        )
        trips_df = trips_df.with_columns(
            pl.when(pl.col('route_long_name').str.to_uppercase().str.contains('UP'))
            .then(pl.lit("0"))
            .when(pl.col('route_long_name').str.to_uppercase().str.contains('DOWN'))
            .then(pl.lit("1"))
            .otherwise(pl.lit("0"))
            .alias('direction')
        )
    
    # Count trips per route and direction, then check if any direction meets threshold
    trip_counts = trips_df.group_by(['route_id', 'direction']).agg(
        pl.len().alias('count')
    )
    
    # Find routes with at least min_trips in any direction using vectorized operations
    def compute_valid(min_required: int) -> Set[str]:
        valid_routes_df = trip_counts.filter(pl.col('count') >= min_required).select('route_id').unique()
        return set(valid_routes_df['route_id'].to_list())

    valid_routes = compute_valid(min_trips)
    # Fallback for sparse datasets: if nothing qualifies, relax to 1
    if not valid_routes and min_trips > 1:
        valid_routes = compute_valid(1)

    return valid_routes


def calculate_destinations_per_stop(trips_df: pl.DataFrame, stop_times_df: pl.DataFrame) -> Dict[str, Set[str]]:
    """
    For each stop, calculate all possible destinations reachable from that stop.
    A destination is any stop that appears after the current stop in any trip.
    """
    print("Calculating destinations per stop...")
    
    # Sort stop_times by trip_id and stop_sequence
    stop_times_df = stop_times_df.sort(['trip_id', 'stop_sequence'])
    
    # Filter to valid trip_ids using Polars operations
    valid_trip_ids = trips_df.select('trip_id').unique()
    stop_times_df = stop_times_df.join(valid_trip_ids, on='trip_id', how='inner')
    
    # Use Polars to create all origin-destination pairs within each trip
    # For each trip, create pairs where origin stop_sequence < destination stop_sequence
    # Create a self-join to find all pairs where same trip_id and origin sequence < dest sequence
    origin_df = stop_times_df.select([
        pl.col('trip_id').alias('trip_id'),
        pl.col('stop_id').alias('origin_stop_id'),
        pl.col('stop_sequence').alias('origin_sequence')
    ])
    
    dest_df = stop_times_df.select([
        pl.col('trip_id').alias('trip_id'),
        pl.col('stop_id').alias('dest_stop_id'),
        pl.col('stop_sequence').alias('dest_sequence')
    ])
    
    # Join to create all valid origin-destination pairs
    pairs_df = origin_df.join(
        dest_df,
        on='trip_id',
        how='inner'
    ).filter(
        pl.col('origin_sequence') < pl.col('dest_sequence')
    ).select([
        pl.col('origin_stop_id').cast(pl.Utf8).alias('stop_id'),
        pl.col('dest_stop_id').cast(pl.Utf8).alias('destination_id')
    ]).unique()
    
    # Group by origin stop and collect all unique destinations
    destinations_df = pairs_df.group_by('stop_id').agg(
        pl.col('destination_id').unique().alias('destinations')
    )
    
    # Convert to dictionary format
    destinations_per_stop = {}
    for row in destinations_df.iter_rows(named=True):
        stop_id = str(row['stop_id'])
        destinations = set(str(d) for d in row['destinations'])
        destinations_per_stop[stop_id] = destinations
    
    print(f"  Completed! Found destinations for {len(destinations_per_stop):,} stops")
    return destinations_per_stop


def haversine_distance_vectorized(
    lat1: pl.Expr, lon1: pl.Expr, lat2: pl.Expr, lon2: pl.Expr
) -> pl.Expr:
    """
    Calculate haversine distance using Polars expressions (vectorized).
    Returns distance in meters.
    """
    # Earth's radius in meters
    R = 6371000
    
    # Convert to radians
    phi1 = lat1 * (math.pi / 180.0)
    phi2 = lat2 * (math.pi / 180.0)
    delta_phi = (lat2 - lat1) * (math.pi / 180.0)
    delta_lambda = (lon2 - lon1) * (math.pi / 180.0)
    
    # Haversine formula
    a = (delta_phi / 2).sin().pow(2) + phi1.cos() * phi2.cos() * (delta_lambda / 2).sin().pow(2)
    # Use atan2 for numerical stability: atan2(sqrt(a), sqrt(1-a))
    sqrt_a = a.sqrt()
    sqrt_one_minus_a = (1 - a).sqrt()
    # Use pl.arctan2 as a function with two expressions
    c = 2 * pl.arctan2(sqrt_a, sqrt_one_minus_a)
    
    return R * c


def find_neighbors(stops_df: pl.DataFrame, radius_meters: float = DEFAULT_NEIGHBOR_RADIUS) -> Dict[str, List[str]]:
    """
    Find neighboring stops based on geographic distance.
    
    For each stop, finds all other stops within the specified radius (in meters).
    Uses vectorized Polars operations for performance.
    """
    print(f"Finding neighboring stops within {radius_meters}m radius...")
    
    # Ensure we have the required columns
    required_cols = ['stop_id', 'stop_lat', 'stop_lon']
    if not all(col in stops_df.columns for col in required_cols):
        raise ValueError(f"stops_df must contain columns: {required_cols}")
    
    # Prepare stops data with string IDs
    stops_prep = stops_df.select([
        pl.col('stop_id').cast(pl.Utf8).alias('stop_id'),
        pl.col('stop_lat').alias('lat'),
        pl.col('stop_lon').alias('lon')
    ])
    
    # Create cross join to compare all pairs of stops
    # Use suffix to distinguish origin and destination
    origin_df = stops_prep.select([
        pl.col('stop_id').alias('origin_id'),
        pl.col('lat').alias('lat1'),
        pl.col('lon').alias('lon1')
    ])
    
    dest_df = stops_prep.select([
        pl.col('stop_id').alias('dest_id'),
        pl.col('lat').alias('lat2'),
        pl.col('lon').alias('lon2')
    ])
    
    # Cross join and calculate distances
    pairs_df = origin_df.join(dest_df, how='cross').filter(
        pl.col('origin_id') != pl.col('dest_id')  # Exclude self
    ).with_columns([
        haversine_distance_vectorized(
            pl.col('lat1'), pl.col('lon1'),
            pl.col('lat2'), pl.col('lon2')
        ).alias('distance')
    ]).filter(
        pl.col('distance') <= radius_meters
    ).select([
        pl.col('origin_id').alias('stop_id'),
        pl.col('dest_id').alias('neighbor_id')
    ])
    
    # Group by origin stop and collect neighbors
    neighbors_df = pairs_df.group_by('stop_id').agg(
        pl.col('neighbor_id').unique().alias('neighbors')
    )
    
    # Convert to dictionary format
    neighbors_dict = {}
    for row in neighbors_df.iter_rows(named=True):
        stop_id = str(row['stop_id'])
        neighbors = [str(n) for n in row['neighbors']]
        neighbors_dict[stop_id] = neighbors
    
    # Ensure all stops are in the dictionary (even if they have no neighbors)
    all_stop_ids = set(stops_prep['stop_id'].to_list())
    for stop_id in all_stop_ids:
        if stop_id not in neighbors_dict:
            neighbors_dict[stop_id] = []
    
    print(f"  Completed! Found neighbors for {len(neighbors_dict):,} stops")
    return neighbors_dict


def calculate_importance_scores(
    destinations_per_stop: Dict[str, Set[str]],
    neighbors: Dict[str, List[str]],
    stops_df: pl.DataFrame
) -> List[Tuple[str, float]]:
    """
    Calculate importance score for each stop.
    
    Importance is calculated as the ratio of unique destinations from this stop
    compared to the average number of destinations from neighboring stops.
    
    A high score means this stop provides access to many destinations that
    neighboring stops don't provide, making it a good interchange point.
    """
    print("Calculating importance scores...")
    
    # Pre-compute neighbor sets for faster lookup
    neighbor_sets = {stop_id: set(neighbor_list) for stop_id, neighbor_list in neighbors.items()}
    
    scores = []
    total_stops = len(destinations_per_stop)
    processed = 0
    
    for stop_id, destinations in destinations_per_stop.items():
        num_destinations = len(destinations)
        
        # Get neighboring stops (use pre-computed set for faster access)
        neighbor_ids = neighbor_sets.get(stop_id, set())
        
        if len(neighbor_ids) == 0:
            # No neighbors - use absolute destination count as score
            importance = num_destinations
        else:
            # Calculate average destinations from neighbors and union
            neighbor_destinations_counts = []
            neighbor_destinations_union = set()
            
            # Use list comprehension for faster iteration
            for neighbor_id in neighbor_ids:
                neighbor_dests = destinations_per_stop.get(neighbor_id, set())
                if neighbor_dests:  # Only process non-empty sets
                    neighbor_destinations_counts.append(len(neighbor_dests))
                    neighbor_destinations_union.update(neighbor_dests)
            
            num_neighbors = len(neighbor_destinations_counts)
            avg_neighbor_destinations = sum(neighbor_destinations_counts) / num_neighbors if num_neighbors > 0 else 0
            
            # Calculate unique destinations (destinations available from this stop but not from neighbors)
            unique_destinations = destinations - neighbor_destinations_union
            num_unique_destinations = len(unique_destinations)
            
            # Importance score combines:
            # 1. Ratio of destinations vs neighbor average (relative importance)
            # 2. Number of unique destinations (interchange value)
            
            if avg_neighbor_destinations > 0:
                ratio_score = num_destinations / avg_neighbor_destinations
            else:
                ratio_score = num_destinations
            
            # Weighted combination: emphasize unique destinations as they indicate interchange value
            importance = (
                0.8 * ratio_score +
                0.2 * num_unique_destinations
            )
        
        scores.append((stop_id, importance))
        
        processed += 1
        if processed % 500 == 0:
            print(f"  Processed {processed:,}/{total_stops:,} stops ({100*processed/total_stops:.1f}%)...")
    
    # Sort by importance (descending)
    scores.sort(key=lambda x: x[1], reverse=True)
    
    print(f"  Completed! Calculated scores for {len(scores):,} stops")
    return scores


def normalize_scores(scores: List[Tuple[str, float]]) -> List[Tuple[str, float]]:
    """Normalize importance scores to 0-100 range."""
    if not scores:
        return []
    
    # Find min and max scores
    min_score = min(score for _, score in scores)
    max_score = max(score for _, score in scores)
    
    # Normalize to 0-100
    if max_score - min_score > 0:
        normalized = [
            (stop_id, 100 * (score - min_score) / (max_score - min_score))
            for stop_id, score in scores
        ]
    else:
        normalized = [(stop_id, 50.0) for stop_id, _ in scores]
    
    return normalized


def main():
    """Main function to process GTFS and generate stop importance rankings."""
    parser = argparse.ArgumentParser(
        description='Rank transit stops by importance (interchange potential)',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    parser.add_argument(
        '--min-trips', 
        type=int, 
        default=DEFAULT_MIN_TRIPS,
        help='Minimum number of trips per day for a route to be included'
    )
    parser.add_argument(
        '--output-dir', 
        type=str, 
        default='.',
        help='Output directory for JSON file'
    )
    parser.add_argument(
        '--city', 
        type=str,
        help='City name (if provided, uses all .zip GTFS files in $city/ and output goes to $city/)'
    )
    parser.add_argument(
        '--gtfs-path', 
        type=str,
        help='Path to a single GTFS zip file (if not using --city)'
    )
    parser.add_argument(
        '--neighbor-radius',
        type=float,
        default=DEFAULT_NEIGHBOR_RADIUS,
        help=f'Radius in meters for finding neighboring stops (default: {DEFAULT_NEIGHBOR_RADIUS})'
    )
    
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
    
    # Load GTFS data
    print("Loading GTFS data...")
    if len(gtfs_paths) > 1:
        print(f"Merging data from {len(gtfs_paths)} GTFS files...")
    gtfs_data = load_gtfs_data_from_multiple_files(gtfs_paths, include_shapes=False)
    routes_df = gtfs_data['routes']
    trips_df = gtfs_data['trips']
    stop_times_df = gtfs_data['stop_times']
    stops_df = gtfs_data['stops']
    
    # Filter to valid routes
    print("Filtering valid routes...")
    valid_routes = get_valid_routes(trips_df, routes_df, args.min_trips)
    print(f"Found {len(valid_routes)} valid routes")
    
    trips_df = trips_df.filter(pl.col('route_id').is_in(list(valid_routes)))
    
    # Filter stops to only those served by valid routes using Polars operations
    valid_trip_ids = trips_df.select('trip_id').unique()
    stop_times_df = stop_times_df.join(valid_trip_ids, on='trip_id', how='inner')
    valid_stop_ids = stop_times_df.select('stop_id').unique()
    stops_df = stops_df.join(valid_stop_ids, on='stop_id', how='inner')
    
    print(f"Working with {len(stops_df)} stops")
    
    # Calculate destinations per stop
    destinations_per_stop = calculate_destinations_per_stop(trips_df, stop_times_df)
    
    # Find neighbors based on geographic distance
    neighbors = find_neighbors(stops_df, args.neighbor_radius)
    
    # Calculate importance scores
    scores = calculate_importance_scores(destinations_per_stop, neighbors, stops_df)
    
    # Normalize scores
    print("Normalizing scores...")
    normalized_scores = normalize_scores(scores)
    
    # Create output dictionary
    output = {
        stop_id: round(score, 2)
        for stop_id, score in normalized_scores
    }
    
    # Save to file
    output_file = os.path.join(output_dir, 'ranking.min.json')
    print(f"Writing rankings to {output_file}...")
    with open(output_file, 'w') as f:
        json.dump(output, f, separators=(',', ':'))
    
    # Print top 20 stops
    print("\n" + "="*60)
    print("Top 20 Most Important Stops:")
    print("="*60)
    
    # Get stop names for display using Polars operations
    stop_names_df = stops_df.select([
        pl.col('stop_id').cast(pl.Utf8).alias('stop_id'),
        pl.col('stop_name').alias('stop_name')
    ])
    stop_names = {
        str(row['stop_id']): row['stop_name']
        for row in stop_names_df.iter_rows(named=True)
    }
    
    for i, (stop_id, score) in enumerate(normalized_scores[:20], 1):
        stop_name = stop_names.get(stop_id, 'Unknown')
        num_destinations = len(destinations_per_stop.get(stop_id, set()))
        print(f"{i:2d}. {stop_name[:40]:40s} (ID: {stop_id:10s}) - Score: {score:6.2f} - {num_destinations:4d} destinations")
    
    print("\n✓ Completed! Rankings saved to", output_file)


if __name__ == '__main__':
    main()

