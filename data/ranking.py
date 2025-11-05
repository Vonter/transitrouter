#!/usr/bin/env python3
import json
import zipfile
import polars as pl
import argparse
import os
from typing import Dict, List, Set, Tuple
from collections import defaultdict

# Default minimum number of trips per day for a route to be included
DEFAULT_MIN_TRIPS = 2

def read_gtfs_file(zip_path: str, filename: str) -> pl.DataFrame:
    """Read a GTFS file from the zip archive into a polars DataFrame."""
    with zipfile.ZipFile(zip_path) as z:
        return pl.read_csv(z.open(filename))


def get_valid_routes(trips_df: pl.DataFrame, routes_df: pl.DataFrame, min_trips: int) -> Set[str]:
    """Get routes that have at least min_trips in at least one direction."""
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


def calculate_destinations_per_stop(trips_df: pl.DataFrame, stop_times_df: pl.DataFrame) -> Dict[str, Set[str]]:
    """
    For each stop, calculate all possible destinations reachable from that stop.
    A destination is any stop that appears after the current stop in any trip.
    """
    print("Calculating destinations per stop...")
    
    # Sort stop_times by trip_id and stop_sequence
    stop_times_df = stop_times_df.sort(['trip_id', 'stop_sequence'])
    
    # Get valid trip_ids
    valid_trip_ids = set(trips_df['trip_id'].to_list())
    stop_times_df = stop_times_df.filter(pl.col('trip_id').is_in(list(valid_trip_ids)))
    
    # Dictionary to store destinations for each stop
    destinations_per_stop = defaultdict(set)
    
    # Group by trip_id to process each trip
    total_trips = stop_times_df['trip_id'].n_unique()
    processed = 0
    
    for trip_id, trip_stops in stop_times_df.group_by('trip_id'):
        trip_stops = trip_stops.sort('stop_sequence')
        stops_list = trip_stops['stop_id'].to_list()
        
        # For each stop in the trip, all subsequent stops are destinations
        for i, stop in enumerate(stops_list):
            stop_id = str(stop)
            # Add all subsequent stops as destinations
            for j in range(i + 1, len(stops_list)):
                destinations_per_stop[stop_id].add(str(stops_list[j]))
        
        processed += 1
        if processed % 1000 == 0:
            print(f"  Processed {processed:,}/{total_trips:,} trips ({100*processed/total_trips:.1f}%)...")
    
    print(f"  Completed! Found destinations for {len(destinations_per_stop):,} stops")
    return dict(destinations_per_stop)


def find_neighbors(stop_times_df: pl.DataFrame) -> Dict[str, List[str]]:
    """Find neighboring stops based on adjacent stops in trip sequences."""
    print("Finding neighboring stops from trip sequences...")
    
    # Sort stop_times by trip_id and stop_sequence
    stop_times_df = stop_times_df.sort(['trip_id', 'stop_sequence'])
    
    neighbors = defaultdict(set)
    
    # Group by trip_id to process each trip
    total_trips = stop_times_df['trip_id'].n_unique()
    processed = 0
    
    for trip_id, trip_stops in stop_times_df.group_by('trip_id'):
        trip_stops = trip_stops.sort('stop_sequence')
        stops_list = trip_stops['stop_id'].to_list()
        
        # For each stop in the trip, find adjacent stops (previous and next)
        for i, stop in enumerate(stops_list):
            stop_id = str(stop)
            
            # Add previous stop as neighbor (if exists)
            if i > 0:
                prev_stop_id = str(stops_list[i - 1])
                if prev_stop_id != stop_id:
                    neighbors[stop_id].add(prev_stop_id)
            
            # Add next stop as neighbor (if exists)
            if i < len(stops_list) - 1:
                next_stop_id = str(stops_list[i + 1])
                if next_stop_id != stop_id:
                    neighbors[stop_id].add(next_stop_id)
        
        processed += 1
        if processed % 1000 == 0:
            print(f"  Processed {processed:,}/{total_trips:,} trips ({100*processed/total_trips:.1f}%)...")
    
    # Convert sets to lists for consistency with previous interface
    neighbors_dict = {stop_id: list(neighbor_set) for stop_id, neighbor_set in neighbors.items()}
    
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
    
    scores = []
    total_stops = len(destinations_per_stop)
    processed = 0
    
    for stop_id, destinations in destinations_per_stop.items():
        num_destinations = len(destinations)
        
        # Get neighboring stops
        neighbor_ids = neighbors.get(stop_id, [])
        
        if len(neighbor_ids) == 0:
            # No neighbors - use absolute destination count as score
            importance = num_destinations
        else:
            # Calculate average destinations from neighbors
            neighbor_destinations_counts = []
            neighbor_destinations_union = set()
            
            for neighbor_id in neighbor_ids:
                neighbor_dests = destinations_per_stop.get(neighbor_id, set())
                neighbor_destinations_counts.append(len(neighbor_dests))
                neighbor_destinations_union.update(neighbor_dests)
            
            avg_neighbor_destinations = sum(neighbor_destinations_counts) / len(neighbor_destinations_counts) if neighbor_destinations_counts else 0
            
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
        help='City name (if provided, output will go to $city/ and read gtfs from $city/gtfs.zip)'
    )
    
    args = parser.parse_args()
    
    # Determine paths
    if args.city:
        output_dir = args.city
        gtfs_path = os.path.join(args.city, 'gtfs.zip')
    else:
        output_dir = args.output_dir
        gtfs_path = os.path.join(args.output_dir, 'gtfs.zip')
    
    # Create output directory if it doesn't exist
    os.makedirs(output_dir, exist_ok=True)
    
    # Load GTFS data
    print("Loading GTFS data...")
    routes_df = read_gtfs_file(gtfs_path, 'routes.txt')
    trips_df = read_gtfs_file(gtfs_path, 'trips.txt')
    stop_times_df = read_gtfs_file(gtfs_path, 'stop_times.txt')
    stops_df = read_gtfs_file(gtfs_path, 'stops.txt')
    
    # Filter to valid routes
    print("Filtering valid routes...")
    valid_routes = get_valid_routes(trips_df, routes_df, args.min_trips)
    print(f"Found {len(valid_routes)} valid routes")
    
    trips_df = trips_df.filter(pl.col('route_id').is_in(list(valid_routes)))
    
    # Filter stops to only those served by valid routes
    valid_trip_ids = set(trips_df['trip_id'].to_list())
    stop_times_df = stop_times_df.filter(pl.col('trip_id').is_in(list(valid_trip_ids)))
    valid_stop_ids = set(stop_times_df['stop_id'].unique().to_list())
    stops_df = stops_df.filter(pl.col('stop_id').is_in(list(valid_stop_ids)))
    
    print(f"Working with {len(stops_df)} stops")
    
    # Calculate destinations per stop
    destinations_per_stop = calculate_destinations_per_stop(trips_df, stop_times_df)
    
    # Find neighbors based on trip sequences
    neighbors = find_neighbors(stop_times_df)
    
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
    
    # Get stop names for display
    stop_names = {
        str(row['stop_id']): row['stop_name']
        for row in stops_df.iter_rows(named=True)
    }
    
    for i, (stop_id, score) in enumerate(normalized_scores[:20], 1):
        stop_name = stop_names.get(stop_id, 'Unknown')
        num_destinations = len(destinations_per_stop.get(stop_id, set()))
        print(f"{i:2d}. {stop_name[:40]:40s} (ID: {stop_id:10s}) - Score: {score:6.2f} - {num_destinations:4d} destinations")
    
    print("\n✓ Completed! Rankings saved to", output_file)


if __name__ == '__main__':
    main()

