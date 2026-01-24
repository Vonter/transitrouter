#!/usr/bin/env python3
"""
BLR (Bangalore) specific utilities for GTFS processing.

Provides city-specific customizations for stop name generation.
"""
import polars as pl
from typing import Dict, Set, List, Tuple
from collections import defaultdict


def get_next_stop_for_stop(
    stop_id: str,
    trips_df: pl.DataFrame,
    stop_times_df: pl.DataFrame,
    valid_routes: Set[str]
) -> str | None:
    """
    For a given stop, find the next stop on the most popular route passing through it.
    
    "Most popular" is determined by the route with the most trips passing through this stop.
    
    Args:
        stop_id: The stop ID to find the next stop for
        trips_df: DataFrame with trip information
        stop_times_df: DataFrame with stop times
        valid_routes: Set of valid route IDs to consider
        
    Returns:
        The stop_id of the next stop on the most popular route, or None if not found
    """
    # Filter trips to valid routes
    valid_trips = trips_df.filter(pl.col('route_id').is_in(list(valid_routes)))
    valid_trip_ids = set(valid_trips['trip_id'].to_list())
    
    # Find all trips that pass through this stop
    trips_through_stop = stop_times_df.filter(
        (pl.col('stop_id') == stop_id) & 
        (pl.col('trip_id').is_in(valid_trip_ids))
    )
    
    if len(trips_through_stop) == 0:
        return None
    
    # For each trip, find the next stop after this one
    next_stops_count = defaultdict(int)
    
    for row in trips_through_stop.to_dicts():
        trip_id = row['trip_id']
        current_sequence = row['stop_sequence']
        
        # Find the next stop in this trip
        next_stop = stop_times_df.filter(
            (pl.col('trip_id') == trip_id) & 
            (pl.col('stop_sequence') > current_sequence)
        ).sort('stop_sequence').head(1)
        
        if len(next_stop) > 0:
            next_stop_id = next_stop['stop_id'][0]
            next_stops_count[next_stop_id] += 1
    
    if not next_stops_count:
        return None
    
    # Return the most common next stop
    return max(next_stops_count.items(), key=lambda x: x[1])[0]


def compute_towards_suffixes(
    stops_dict: Dict[str, List],
    gtfs_data: Dict[str, pl.DataFrame],
    valid_routes: Set[str]
) -> Dict[str, str]:
    """
    Compute "(Towards X)" suffixes for all stops.
    
    For stops with the same name, this helps distinguish them by indicating
    the direction of travel (the next stop on the most popular route).
    
    Args:
        stops_dict: Dictionary of stop_id -> [lon, lat, name, suffix]
        gtfs_data: Dictionary containing 'trips', 'stop_times', 'stops' DataFrames
        valid_routes: Set of valid route IDs
        
    Returns:
        Dictionary of stop_id -> suffix string (e.g., "(Towards Majestic)")
    """
    trips_df = gtfs_data['trips']
    stop_times_df = gtfs_data['stop_times']
    
    # Build stop_id -> name mapping
    stop_names = {stop_id: data[2] for stop_id, data in stops_dict.items()}
    
    # Find stops with duplicate names
    name_to_stops = defaultdict(list)
    for stop_id, name in stop_names.items():
        name_to_stops[name].append(stop_id)
    
    # Only process stops that have duplicate names
    duplicate_name_stops = {
        stop_id 
        for name, stop_ids in name_to_stops.items() 
        if len(stop_ids) > 1
        for stop_id in stop_ids
    }
    
    print(f"  Found {len(duplicate_name_stops)} stops with duplicate names")
    
    # Pre-compute next stops for efficiency
    # Group stop_times by trip_id and sort by sequence
    stop_times_sorted = stop_times_df.sort(['trip_id', 'stop_sequence'])
    
    # Create a mapping of (trip_id, stop_id) -> next_stop_id
    # Using a more efficient approach with Polars
    
    # Filter to valid trips
    valid_trips = trips_df.filter(pl.col('route_id').is_in(list(valid_routes)))
    valid_trip_ids = valid_trips.select('trip_id')
    
    stop_times_valid = stop_times_sorted.join(valid_trip_ids, on='trip_id', how='inner')
    
    # Add a column for the next stop_id within each trip
    stop_times_with_next = stop_times_valid.with_columns([
        pl.col('stop_id').shift(-1).over('trip_id').alias('next_stop_id'),
        pl.col('stop_sequence').shift(-1).over('trip_id').alias('next_sequence')
    ])
    
    # Filter out rows where there's no next stop (last stop in trip)
    stop_times_with_next = stop_times_with_next.filter(
        pl.col('next_stop_id').is_not_null()
    )
    
    # Count occurrences of each (stop_id, next_stop_id) pair
    next_stop_counts = stop_times_with_next.group_by(['stop_id', 'next_stop_id']).agg(
        pl.count().alias('count')
    )
    
    # For each stop, find the most common next stop
    most_common_next = next_stop_counts.sort(['stop_id', 'count'], descending=[False, True]).group_by('stop_id').agg(
        pl.first('next_stop_id').alias('best_next_stop')
    )
    
    # Convert to dictionary
    stop_to_next = {
        row['stop_id']: row['best_next_stop']
        for row in most_common_next.to_dicts()
    }
    
    # Build suffix dictionary for duplicate-name stops
    suffixes = {}
    processed = 0
    
    for stop_id in duplicate_name_stops:
        next_stop_id = stop_to_next.get(stop_id)
        
        if next_stop_id and next_stop_id in stop_names:
            next_stop_name = stop_names[next_stop_id]
            suffixes[stop_id] = f"(Towards {next_stop_name})"
        
        processed += 1
        if processed % 500 == 0:
            print(f"    Processed {processed}/{len(duplicate_name_stops)} duplicate-name stops...")
    
    print(f"  Generated {len(suffixes)} suffixes for duplicate-name stops")
    
    return suffixes


def process_stop_names(
    stops_dict: Dict[str, List],
    gtfs_data: Dict[str, pl.DataFrame],
    valid_routes: Set[str]
) -> Dict[str, List]:
    """
    Process stop names to add "(Towards X)" suffix for disambiguation.
    
    This is the main entry point called by routes.py.
    
    Args:
        stops_dict: Dictionary of stop_id -> [lon, lat, name, suffix]
        gtfs_data: Dictionary containing GTFS DataFrames
        valid_routes: Set of valid route IDs
        
    Returns:
        Modified stops_dict with updated suffixes
    """
    print("BLR: Adding 'Towards' suffixes to disambiguate duplicate stop names...")
    
    suffixes = compute_towards_suffixes(stops_dict, gtfs_data, valid_routes)
    
    # Update the stops_dict with the computed suffixes
    for stop_id, suffix in suffixes.items():
        if stop_id in stops_dict:
            # The 4th element (index 3) is the suffix field
            stops_dict[stop_id][3] = suffix
    
    return stops_dict
