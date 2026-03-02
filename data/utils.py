#!/usr/bin/env python3
"""
Common utilities for GTFS processing scripts.
"""
import zipfile
import polars as pl
from pathlib import Path
from typing import Dict, List


def read_gtfs_file(zip_path: str, filename: str) -> pl.DataFrame:
    """Read a GTFS file from the zip archive into a polars DataFrame."""
    # Ensure stable types across GTFS files: IDs as strings; decimals as Float64.
    id_columns = [
        'route_id', 'trip_id', 'stop_id', 'shape_id', 'service_id',
        'agency_id', 'block_id', 'fare_id', 'zone_id', 'parent_station'
    ]
    float_columns = [
        'shape_dist_traveled', 'stop_lat', 'stop_lon', 'shape_pt_lat', 'shape_pt_lon'
    ]
    schema_overrides = {col: pl.Utf8 for col in id_columns}
    schema_overrides.update({col: pl.Float64 for col in float_columns})

    with zipfile.ZipFile(zip_path) as z:
        if filename not in z.namelist():
            # Return empty DataFrame with expected schema if file doesn't exist
            return pl.DataFrame()
        return pl.read_csv(
            z.open(filename),
            schema_overrides=schema_overrides,
            infer_schema_length=10000
        )


def find_gtfs_files(city_dir: str) -> List[str]:
    """Find all .zip GTFS files in a city directory."""
    city_path = Path(city_dir)
    if not city_path.exists():
        return []
    zip_files = sorted(city_path.glob('*.zip'))
    return [str(f) for f in zip_files]


def normalize_schema(dfs: List[pl.DataFrame]) -> List[pl.DataFrame]:
    """Normalize schemas of multiple DataFrames to have the same columns and compatible types."""
    if not dfs:
        return dfs
    
    # Collect all unique columns and their types across all DataFrames
    column_types = {}
    all_columns = set()
    for df in dfs:
        all_columns.update(df.columns)
        for col in df.columns:
            col_type = df[col].dtype
            # If column already exists, use the more general type
            # Prefer String over Null, and keep the first non-Null type
            if col not in column_types:
                column_types[col] = col_type
            elif column_types[col] == pl.Null and col_type != pl.Null:
                column_types[col] = col_type
            elif col_type != pl.Null and column_types[col] == pl.Null:
                # Keep the non-Null type
                pass
            # If both are non-Null and different, prefer String for compatibility
            elif col_type == pl.Utf8 and column_types[col] != pl.Utf8:
                column_types[col] = pl.Utf8
    
    # Sort columns for consistency
    all_columns = sorted(all_columns)
    
    # Normalize each DataFrame to have all columns with compatible types
    normalized_dfs = []
    for df in dfs:
        # Add missing columns with appropriate types
        missing_columns = set(all_columns) - set(df.columns)
        if missing_columns:
            for col in missing_columns:
                col_type = column_types.get(col, pl.Utf8)
                # Add column with null values but correct type
                df = df.with_columns(pl.lit(None, dtype=col_type).alias(col))
        
        # Cast existing columns to match unified schema if needed
        for col in df.columns:
            if col in column_types:
                expected_type = column_types[col]
                if df[col].dtype != expected_type and df[col].dtype != pl.Null:
                    # Try to cast to expected type
                    try:
                        df = df.with_columns(pl.col(col).cast(expected_type, strict=False))
                    except:
                        # If casting fails, keep original type
                        pass
        
        # Reorder columns to match all_columns order
        df = df.select(all_columns)
        normalized_dfs.append(df)
    
    return normalized_dfs


def load_gtfs_data_from_multiple_files(gtfs_paths: List[str], include_shapes: bool = False) -> Dict[str, pl.DataFrame]:
    """Load and merge GTFS data from multiple zip files.
    
    Args:
        gtfs_paths: List of paths to GTFS zip files
        include_shapes: Whether to include shapes.txt data (default: False)
    
    Returns:
        Dictionary with keys: 'routes', 'trips', 'stop_times', 'stops', and optionally 'shapes'
    """
    all_data = {
        'routes': [],
        'trips': [],
        'stop_times': [],
        'stops': [],
        'frequencies': [],
    }

    if include_shapes:
        all_data['shapes'] = []

    for gtfs_path in gtfs_paths:
        print(f"  Loading {Path(gtfs_path).name}...")
        # Read routes
        routes_df = read_gtfs_file(gtfs_path, 'routes.txt')
        if len(routes_df) > 0:
            all_data['routes'].append(routes_df)

        # Read trips
        trips_df = read_gtfs_file(gtfs_path, 'trips.txt')
        if len(trips_df) > 0:
            all_data['trips'].append(trips_df)

        # Read stop_times
        stop_times_df = read_gtfs_file(gtfs_path, 'stop_times.txt')
        if len(stop_times_df) > 0:
            all_data['stop_times'].append(stop_times_df)

        # Read stops
        stops_df = read_gtfs_file(gtfs_path, 'stops.txt')
        if len(stops_df) > 0:
            all_data['stops'].append(stops_df)

        # Read frequencies (optional, used by frequency-based GTFS feeds)
        freq_df = read_gtfs_file(gtfs_path, 'frequencies.txt')
        if len(freq_df) > 0:
            all_data['frequencies'].append(freq_df)

        # Check for shapes file if requested
        if include_shapes:
            with zipfile.ZipFile(gtfs_path) as z:
                if 'shapes.txt' in z.namelist():
                    shapes_df = read_gtfs_file(gtfs_path, 'shapes.txt')
                    if len(shapes_df) > 0:
                        all_data['shapes'].append(shapes_df)
    
    # Concatenate all dataframes with normalized schemas
    merged_data = {}
    for key, dfs in all_data.items():
        if dfs:
            # Normalize schemas before concatenation
            normalized_dfs = normalize_schema(dfs)
            if key == 'shapes':
                # Sort shapes after concatenation
                merged_data[key] = pl.concat(normalized_dfs).sort(['shape_id', 'shape_pt_sequence'])
            else:
                merged_data[key] = pl.concat(normalized_dfs)
        else:
            # Create empty DataFrame with expected schema
            merged_data[key] = pl.DataFrame()
    
    return merged_data

