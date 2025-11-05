#!/usr/bin/env python3
"""
Script to run routes.py, schedule.py, firstlast.py, and ranking.py for each city.
Logs the status of each city to parse.log.
"""

import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# List of cities to process (based on available directories)
CITIES = ['blr', 'chennai', 'delhi', 'goa', 'kochi', 'pune', 'railways', 'greyhound']

# Scripts to run in order
SCRIPTS = [
    ('routes.py', ['--city']),
    ('schedule.py', ['--city', '--gtfs-path']),  # Needs explicit gtfs-path
    ('firstlast.py', ['--city']),
    ('ranking.py', ['--city']),
]

LOG_FILE = 'parse.log'


def log_message(message: str, log_file: str = LOG_FILE):
    """Write a message to the log file with timestamp."""
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    log_entry = f"[{timestamp}] {message}\n"
    
    with open(log_file, 'a', encoding='utf-8') as f:
        f.write(log_entry)
    
    # Also print to console
    print(log_entry.strip())


def run_script(script_name: str, city: str, args: list) -> tuple[bool, str]:
    """
    Run a script for a given city.
    
    Returns:
        (success: bool, error_message: str)
    """
    script_path = Path(__file__).parent / script_name
    
    if not script_path.exists():
        return False, f"Script {script_name} not found"
    
    # Build command arguments
    cmd = [sys.executable, str(script_path)]
    
    # Add arguments based on script requirements
    for arg in args:
        if arg == '--city':
            cmd.extend(['--city', city])
        elif arg == '--gtfs-path':
            # For schedule.py, we need to provide the gtfs.zip path
            gtfs_path = os.path.join(city, 'gtfs.zip')
            cmd.extend(['--gtfs-path', gtfs_path])
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=3600  # 1 hour timeout per script
        )
        
        if result.returncode == 0:
            return True, ""
        else:
            error_msg = result.stderr.strip() or result.stdout.strip()
            return False, error_msg
            
    except subprocess.TimeoutExpired:
        return False, f"Script timed out after 1 hour"
    except Exception as e:
        return False, f"Error running script: {str(e)}"


def process_city(city: str) -> dict:
    """
    Process all scripts for a single city.
    
    Returns:
        Dictionary with status for each script
    """
    city_dir = Path(city)
    
    # Check if city directory exists
    if not city_dir.exists():
        return {
            'status': 'error',
            'message': f"City directory '{city}' does not exist",
            'scripts': {}
        }
    
    # Check if gtfs.zip exists (required for most scripts)
    gtfs_path = city_dir / 'gtfs.zip'
    if not gtfs_path.exists():
        return {
            'status': 'error',
            'message': f"gtfs.zip not found in '{city}' directory",
            'scripts': {}
        }
    
    results = {
        'status': 'success',
        'scripts': {}
    }
    
    # Run each script
    for script_name, script_args in SCRIPTS:
        log_message(f"Running {script_name} for {city}...")
        success, error_msg = run_script(script_name, city, script_args)
        
        script_result = {
            'success': success,
            'error': error_msg if not success else None
        }
        results['scripts'][script_name] = script_result
        
        if success:
            log_message(f"✓ {script_name} completed successfully for {city}")
        else:
            log_message(f"✗ {script_name} failed for {city}: {error_msg}")
            results['status'] = 'partial' if results['status'] == 'success' else 'error'
    
    return results


def main():
    """Main function to process all cities."""
    # Clear or create log file
    log_file = Path(LOG_FILE)
    if log_file.exists():
        log_file.unlink()
    
    log_message("=" * 80)
    log_message("Starting batch processing of cities")
    log_message("=" * 80)
    
    # Process each city
    city_results = {}
    for city in CITIES:
        log_message(f"\n{'='*80}")
        log_message(f"Processing city: {city}")
        log_message(f"{'='*80}")
        
        results = process_city(city)
        city_results[city] = results
        
        # Log summary for this city
        if results['status'] == 'success':
            log_message(f"✓ {city}: All scripts completed successfully")
        elif results['status'] == 'partial':
            log_message(f"⚠ {city}: Some scripts failed")
            failed_scripts = [name for name, result in results['scripts'].items() 
                            if not result['success']]
            log_message(f"  Failed scripts: {', '.join(failed_scripts)}")
        else:
            log_message(f"✗ {city}: {results.get('message', 'Processing failed')}")
    
    # Final summary
    log_message(f"\n{'='*80}")
    log_message("Processing Summary")
    log_message(f"{'='*80}")
    
    successful = sum(1 for r in city_results.values() if r['status'] == 'success')
    partial = sum(1 for r in city_results.values() if r['status'] == 'partial')
    failed = sum(1 for r in city_results.values() if r['status'] == 'error')
    
    log_message(f"Total cities: {len(CITIES)}")
    log_message(f"Successful: {successful}")
    log_message(f"Partial: {partial}")
    log_message(f"Failed: {failed}")
    
    # Detailed breakdown
    log_message(f"\nDetailed Results:")
    for city, results in city_results.items():
        log_message(f"\n{city}:")
        if results['status'] == 'error':
            log_message(f"  Status: ERROR - {results.get('message', 'Unknown error')}")
        else:
            log_message(f"  Status: {results['status'].upper()}")
            for script_name, script_result in results['scripts'].items():
                status_icon = "✓" if script_result['success'] else "✗"
                log_message(f"    {status_icon} {script_name}")
                if not script_result['success']:
                    log_message(f"      Error: {script_result['error']}")
    
    log_message(f"\n{'='*80}")
    log_message("Batch processing completed")
    log_message(f"{'='*80}\n")
    
    # Return exit code based on results
    if failed > 0:
        return 1
    elif partial > 0:
        return 2
    else:
        return 0


if __name__ == '__main__':
    sys.exit(main())

