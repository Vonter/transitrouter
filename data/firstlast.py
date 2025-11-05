#!/usr/bin/env python3
import json
import os
import argparse
from collections import defaultdict
from typing import Dict, List


def convert_time_to_hhmm(time_str: str) -> str:
    """Convert time string from HH:MM to HHMM format."""
    try:
        parts = time_str.split(':')
        return f"{int(parts[0]):02d}{int(parts[1]):02d}"
    except (ValueError, IndexError):
        return "0000"


def process_schedule_files(schedule_dir: str, output_file: str):
    """Process schedule JSON files and generate firstlast.min.json."""
    
    print(f"Processing schedule files from: {schedule_dir}")
    
    # Dictionary to store first/last times for each stop
    firstlast_data = {}
    
    # Get all JSON files in the schedule directory
    schedule_files = [f for f in os.listdir(schedule_dir) if f.endswith('.json')]
    
    print(f"Found {len(schedule_files)} schedule files")
    
    total_files = len(schedule_files)
    for i, filename in enumerate(sorted(schedule_files), 1):
        if i % 100 == 0:
            print(f"Processing file {i:,}/{total_files:,} ({100*i/total_files:.1f}%)...")
        
        stop_id = filename.replace('.json', '')
        file_path = os.path.join(schedule_dir, filename)
        
        try:
            with open(file_path, 'r') as f:
                data = json.load(f)
            
            # Process each service/route at this stop, grouping by route_no
            routes_by_no = defaultdict(list)
            
            for service in data.get('services', []):
                route_no = service.get('no', '')
                trips = service.get('trips', [])
                
                if not trips or not route_no:
                    continue
                
                # Collect all trips for this route_no
                routes_by_no[route_no].extend(trips)
            
            # Create entries for each unique route_no
            route_entries = []
            for route_no, all_trips in sorted(routes_by_no.items()):
                # Find earliest and latest times across all trips for this route
                earliest = min(all_trips)
                latest = max(all_trips)
                
                # Convert to HHMM format
                earliest_hhmm = convert_time_to_hhmm(earliest)
                latest_hhmm = convert_time_to_hhmm(latest)
                
                # Format: "route_no earliest latest = = = =" (weekday only, other days equal)
                entry = f"{route_no} {earliest_hhmm} {latest_hhmm} = = = ="
                route_entries.append(entry)
            
            # Only add to output if there are entries
            if route_entries:
                firstlast_data[stop_id] = route_entries
                
        except (json.JSONDecodeError, IOError) as e:
            print(f"Warning: Failed to process {filename}: {e}")
            continue
    
    # Write output file
    print(f"\nWriting output to: {output_file}")
    with open(output_file, 'w') as f:
        json.dump(firstlast_data, f, separators=(',', ':'))
    
    print(f"✓ Completed! Generated firstlast.min.json with {len(firstlast_data):,} stops")


def main():
    """Main function to generate firstlast.min.json."""
    parser = argparse.ArgumentParser(
        description='Generate firstlast.min.json from schedule files',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    parser.add_argument(
        '--schedule-dir',
        type=str,
        default='blr/schedule',
        help='Directory containing schedule JSON files'
    )
    parser.add_argument(
        '--output',
        type=str,
        default='blr/firstlast.min.json',
        help='Output file path for firstlast.min.json'
    )
    parser.add_argument(
        '--city',
        type=str,
        help='City name (if provided, uses $city/schedule/ and outputs to $city/firstlast.min.json)'
    )
    
    args = parser.parse_args()
    
    # Determine paths based on city argument
    if args.city:
        schedule_dir = os.path.join(args.city, 'schedule')
        output_file = os.path.join(args.city, 'firstlast.min.json')
    else:
        schedule_dir = args.schedule_dir
        output_file = args.output
    
    # Check if schedule directory exists
    if not os.path.isdir(schedule_dir):
        print(f"Error: Schedule directory not found: {schedule_dir}")
        return 1
    
    # Process schedule files
    try:
        process_schedule_files(schedule_dir, output_file)
    except Exception as e:
        print(f"Error generating firstlast.min.json: {e}")
        import traceback
        traceback.print_exc()
        return 1
    
    return 0


if __name__ == '__main__':
    exit(main())

