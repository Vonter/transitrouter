#!/usr/bin/env python3
"""
Script to generate the required JSON files using the GTFS data for each city.
Logs during processing are saved to parse.log.
"""

import argparse
import hashlib
import json
import subprocess
import sys
import urllib.request
from collections import Counter
from datetime import datetime
from pathlib import Path

SCRIPTS = [
    ('routes.py', ['--city']),
    ('schedule.py', ['--city']),
    ('firstlast.py', ['--city']),
    ('ranking.py', ['--city']),
    ('pois.py', ['--city']),
]

LOG_FILE = 'parse.log'
HASH_FILE = 'gtfs-hashes.txt'
SOURCES_FILE = 'sources.json'
TIMEOUT = 3600  # 1 hour
SCRIPT_DIR = Path(__file__).parent


def get_available_cities() -> list[str]:
    """Return sorted list of city directories that contain GTFS files."""
    return sorted(
        item.name for item in SCRIPT_DIR.iterdir()
        if item.is_dir() and not item.name.startswith('.') and list(item.glob('*.zip'))
    )


def load_sources() -> dict:
    """Load GTFS feed sources from sources.json."""
    sources_path = SCRIPT_DIR / SOURCES_FILE
    if not sources_path.exists():
        return {}
    with open(sources_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def download_feed(city: str, url: str, filename: str) -> bool:
    """Download a GTFS feed ZIP for a city. Returns True on success."""
    city_dir = SCRIPT_DIR / city
    city_dir.mkdir(exist_ok=True)
    dest = city_dir / filename
    log_message(f"Downloading {city} GTFS feed...")
    try:
        urllib.request.urlretrieve(url, dest)
        log_message(f"✓ Downloaded {city}: {filename}")
        return True
    except Exception as e:
        log_message(f"✗ Failed to download {city}: {e}")
        return False


def download_feeds(cities: list[str] | None = None) -> list[str]:
    """Download GTFS feeds for cities listed in sources.json.
    Returns list of cities that failed to download."""
    sources = load_sources()
    if not sources:
        return []

    targets = [c for c in (cities or sources.keys()) if c in sources]
    return [city for city in targets
            if not download_feed(city, sources[city]['url'], sources[city]['filename'])]


def calculate_file_hash(file_path: Path) -> str:
    """Calculate SHA256 hash of a file."""
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def load_hashes() -> dict[str, dict[str, str]]:
    """Load GTFS file hashes from gtfs-hashes.txt."""
    hash_file = SCRIPT_DIR / HASH_FILE
    if not hash_file.exists():
        return {}
    
    hashes = {}
    current_city = None
    
    with open(hash_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            
            if line.endswith(':'):
                current_city = line[:-1]
                hashes[current_city] = {}
            elif current_city and ':' in line:
                filename, hash_value = line.split(':', 1)
                hashes[current_city][filename.strip()] = hash_value.strip()
    
    return hashes


def save_hashes(hashes: dict[str, dict[str, str]]):
    """Save GTFS file hashes to gtfs-hashes.txt."""
    with open(SCRIPT_DIR / HASH_FILE, 'w', encoding='utf-8') as f:
        for city in sorted(hashes.keys()):
            f.write(f"{city}:\n")
            for filename in sorted(hashes[city].keys()):
                f.write(f"  {filename}: {hashes[city][filename]}\n")


def get_city_gtfs_hashes(city: str) -> dict[str, str]:
    """Calculate SHA256 hashes for all GTFS files in a city directory."""
    city_dir = Path(city)
    if not city_dir.exists():
        return {}
    
    return {
        zip_file.name: calculate_file_hash(zip_file)
        for zip_file in sorted(city_dir.glob('*.zip'))
    }


def needs_reprocessing(city: str, saved_hashes: dict[str, dict[str, str]]) -> bool:
    """Check if a city needs reprocessing based on GTFS file hashes."""
    current_hashes = get_city_gtfs_hashes(city)
    city_saved = saved_hashes.get(city, {})
    
    return (len(current_hashes) != len(city_saved) or
            any(filename not in city_saved or city_saved[filename] != hash_val
                for filename, hash_val in current_hashes.items()))


def log_message(message: str, log_file: str = LOG_FILE):
    """Write a timestamped message to log file and console."""
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    log_entry = f"[{timestamp}] {message}\n"
    with open(log_file, 'a', encoding='utf-8') as f:
        f.write(log_entry)
    print(log_entry.strip())


def run_script(script_name: str, city: str, args: list) -> tuple[bool, str]:
    """Run a script for a given city. Returns (success, error_message)."""
    script_path = SCRIPT_DIR / script_name
    if not script_path.exists():
        return False, f"Script {script_name} not found"
    
    cmd = [sys.executable, str(script_path)]
    cmd.extend(['--city', city] if '--city' in args else [])
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
        if result.returncode == 0:
            return True, ""
        error = result.stderr.strip() or result.stdout.strip() or "Unknown error"
        return False, error
    except subprocess.TimeoutExpired:
        return False, f"Script timed out after {TIMEOUT // 3600} hour"
    except Exception as e:
        return False, f"Error running script: {e}"


def process_city(city: str, scripts: list = SCRIPTS) -> dict:
    """Process the given scripts for a single city. Returns status dictionary."""
    city_dir = Path(city)

    if not city_dir.exists():
        return {'status': 'error', 'message': f"City directory '{city}' does not exist", 'scripts': {}}

    zip_files = list(city_dir.glob('*.zip'))
    if not zip_files:
        return {'status': 'error', 'message': f"No GTFS files found in '{city}' directory", 'scripts': {}}

    results = {'status': 'success', 'scripts': {}}

    for script_name, script_args in scripts:
        log_message(f"Running {script_name} for {city}...")
        success, error_msg = run_script(script_name, city, script_args)
        
        results['scripts'][script_name] = {'success': success, 'error': error_msg if not success else None}
        
        if success:
            log_message(f"✓ {script_name} completed successfully for {city}")
        else:
            log_message(f"✗ {script_name} failed for {city}: {error_msg}")
            results['status'] = 'partial' if results['status'] == 'success' else 'error'
    
    # Save GTFS file hashes after successful processing
    if results['status'] == 'success':
        log_message(f"Calculating GTFS file hashes for {city}...")
        saved_hashes = load_hashes()
        saved_hashes[city] = get_city_gtfs_hashes(city)
        save_hashes(saved_hashes)
        log_message(f"✓ Saved GTFS file hashes for {city}")
    
    return results


def log_city_summary(city: str, results: dict):
    """Log summary for a single city."""
    status = results['status']
    if status == 'success':
        log_message(f"✓ {city}: All scripts completed successfully")
    elif status == 'partial':
        failed = [name for name, r in results['scripts'].items() if not r['success']]
        log_message(f"⚠ {city}: Some scripts failed")
        log_message(f"  Failed scripts: {', '.join(failed)}")
    else:
        log_message(f"✗ {city}: {results.get('message', 'Processing failed')}")


def get_status_counts(city_results: dict) -> dict:
    """Calculate status counts from city results."""
    return Counter(r['status'] for r in city_results.values())


def run_global_transfers():
    """Run globaltransfers.py once, after all cities have been processed, to
    build the cross-city walkable-transfer graph used by all-mode routing."""
    log_message("Running globaltransfers.py (global transfer graph)...")
    cmd = [sys.executable, str(SCRIPT_DIR / 'globaltransfers.py')]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
        if result.returncode == 0:
            log_message("✓ globaltransfers.py completed successfully")
            if result.stdout.strip():
                log_message(result.stdout.strip())
        else:
            error = result.stderr.strip() or result.stdout.strip() or "Unknown error"
            log_message(f"✗ globaltransfers.py failed: {error}")
    except subprocess.TimeoutExpired:
        log_message(f"✗ globaltransfers.py timed out after {TIMEOUT // 3600} hour")
    except Exception as e:
        log_message(f"✗ Error running globaltransfers.py: {e}")


def run_global_frequency():
    """Run globalfrequency.py once, after schedule.py has produced each city's
    schedule/ directory, to build the nationwide per-stop trip-frequency
    index used by all-mode routing's search cost function."""
    log_message("Running globalfrequency.py (global frequency index)...")
    cmd = [sys.executable, str(SCRIPT_DIR / 'globalfrequency.py')]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
        if result.returncode == 0:
            log_message("✓ globalfrequency.py completed successfully")
            if result.stdout.strip():
                log_message(result.stdout.strip())
        else:
            error = result.stderr.strip() or result.stdout.strip() or "Unknown error"
            log_message(f"✗ globalfrequency.py failed: {error}")
    except subprocess.TimeoutExpired:
        log_message(f"✗ globalfrequency.py timed out after {TIMEOUT // 3600} hour")
    except Exception as e:
        log_message(f"✗ Error running globalfrequency.py: {e}")


def log_final_summary(city_results: dict, cities_to_process: list, status_counts: dict):
    """Log final processing summary."""
    log_message(f"\n{'='*80}")
    log_message("Processing Summary")
    log_message(f"{'='*80}")
    log_message(f"Total cities: {len(cities_to_process)}")
    log_message(f"Successful: {status_counts.get('success', 0)}")
    log_message(f"Partial: {status_counts.get('partial', 0)}")
    log_message(f"Failed: {status_counts.get('error', 0)}")
    
    log_message(f"\nDetailed Results:")
    for city, results in city_results.items():
        log_message(f"\n{city}:")
        if results['status'] == 'error':
            log_message(f"  Status: ERROR - {results.get('message', 'Unknown error')}")
        else:
            log_message(f"  Status: {results['status'].upper()}")
            for script_name, script_result in results['scripts'].items():
                icon = "✓" if script_result['success'] else "✗"
                log_message(f"    {icon} {script_name}")
                if not script_result['success']:
                    log_message(f"      Error: {script_result['error']}")


def main():
    """Main function to process all cities."""
    parser = argparse.ArgumentParser(
        description='Process GTFS data for one or more cities',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s                    # Process all available cities
  %(prog)s blr chennai        # Process only blr and chennai
  %(prog)s --force-reprocess  # Reprocess all cities regardless of hashes
        """
    )
    parser.add_argument('cities', nargs='*', help='List of cities to process (default: all available cities)')
    parser.add_argument('--force-reprocess', action='store_true',
                       help='Force reprocessing of all cities, ignoring saved hashes')
    parser.add_argument('--skip-pois', action='store_true',
                       help='Skip generating points of interest (pois.py)')
    args = parser.parse_args()

    scripts = [s for s in SCRIPTS if not (args.skip_pois and s[0] == 'pois.py')]

    # Initialize log file
    if (log_file := Path(LOG_FILE)).exists():
        log_file.unlink()

    # Download configured feeds before scanning for available cities
    failed_downloads = download_feeds(args.cities or None)
    if failed_downloads:
        log_message(f"Warning: Failed to download feeds for: {', '.join(failed_downloads)}")

    # Determine cities to process
    cities_to_process = args.cities or get_available_cities()
    if not cities_to_process:
        print("Error: No city directories with GTFS files found")
        return 1

    # Validate cities
    available_cities = set(get_available_cities())
    invalid_cities = [c for c in cities_to_process if c not in available_cities]
    if invalid_cities:
        print(f"Error: The following cities are not available: {', '.join(invalid_cities)}")
        print(f"Available cities: {', '.join(sorted(available_cities))}")
        return 1

    log_message("=" * 80)
    log_message("Starting batch processing of cities")
    log_message("=" * 80)
    log_message(f"Cities to process: {', '.join(cities_to_process)}")
    
    # Load saved hashes if not forcing reprocess
    saved_hashes = load_hashes() if not args.force_reprocess else {}
    if saved_hashes:
        log_message(f"Loaded hashes from {HASH_FILE}")
    
    # Check which cities need processing
    cities_to_process_list = []
    cities_skipped = []
    
    for city in cities_to_process:
        if args.force_reprocess or needs_reprocessing(city, saved_hashes):
            cities_to_process_list.append(city)
        else:
            cities_skipped.append(city)
            log_message(f"⏭ {city}: All GTFS files already processed (hashes match), skipping")
    
    if cities_skipped:
        log_message(f"\nSkipped {len(cities_skipped)} city/cities: {', '.join(cities_skipped)}")
    
    if not cities_to_process_list:
        log_message("\nAll cities are already processed. Use --force-reprocess to reprocess.")
        run_global_transfers()
        run_global_frequency()
        return 0
    
    # Process each city that needs processing
    city_results = {}
    for city in cities_to_process_list:
        log_message(f"\n{'='*80}")
        log_message(f"Processing city: {city}")
        log_message(f"{'='*80}")
        
        city_results[city] = process_city(city, scripts)
        log_city_summary(city, city_results[city])
    
    # Final summary
    status_counts = get_status_counts(city_results)
    log_final_summary(city_results, cities_to_process_list, status_counts)

    run_global_transfers()
    run_global_frequency()

    log_message(f"\n{'='*80}")
    log_message("Batch processing completed")
    log_message(f"{'='*80}\n")
    
    # Return exit code
    if status_counts.get('error', 0) > 0:
        return 1
    elif status_counts.get('partial', 0) > 0:
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
