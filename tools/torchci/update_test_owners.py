#!/usr/bin/env python3
"""
Script to check files in pytorch/pytorch test folder for Owner(s) lines
and generate a JSON file with filename and owner_label information.
"""

import os
import json
import re
import subprocess
import tempfile
import argparse
import time
from pathlib import Path
from typing import List, Dict, Optional


def clone_pytorch_repo(temp_dir: str) -> str:
    """Clone the pytorch/pytorch repository to a temporary directory."""
    repo_url = "https://github.com/pytorch/pytorch.git"
    repo_path = os.path.join(temp_dir, "pytorch")

    print(f"Cloning pytorch repository to {repo_path}...")
    subprocess.run(
        ["git", "clone", "--depth", "1", repo_url, repo_path],
        check=True,
        capture_output=True
    )

    return repo_path


def find_owner_line(file_path: str) -> Optional[List[str]]:
    """
    Search for a line that looks like with '# Owner(s): ["module: unknown"]' in
    the file and returns ["module: unknown"].
    """
    with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
        for line in f:
            # Look for lines that start with # Owner(s): (allowing for whitespace)
            match = re.match(r'^\s*#\s*Owner\(s\):\s*(.+)$', line, re.IGNORECASE)
            if match:
                owner_label_string = match.group(1).strip()

                # Try to parse as JSON list
                parsed_list = json.loads(owner_label_string)
                if isinstance(parsed_list, list):
                    return [str(item).strip() for item in parsed_list if str(item).strip()]

                return [owner_label_string]
    return None


def scan_test_files(repo_path: str) -> List[Dict[str, any]]:
    """
    Scan all files in the test directory for owner_label information.
    Returns a list of dictionaries with filename and owner_label.
    """
    test_dir = Path(repo_path) / "test"
    results = []

    print(f"Scanning test files in {test_dir}...")
    # Use glob to find all Python files in test directory and subdirectories
    for file_path in test_dir.rglob("test*.py"):
        relative_path = os.path.relpath(str(file_path), test_dir)
        owner_label = find_owner_line(str(file_path))
        if owner_label:
            results.append({
                "file": relative_path,
                "owner_labels": owner_label
            })
        else:
            print(f"No owner label found in {relative_path}")

    return results


def main():
    """Main function to execute the script."""
    parser = argparse.ArgumentParser(
        description="Check pytorch/pytorch test files for owner_label information"
    )
    parser.add_argument(
        "--output", "-o",
        default="test_owner_labels.json",
        help="Output JSON file path (default: test_owner_labels.json)"
    )
    parser.add_argument(
        "--repo-path",
        help="Path to existing pytorch repository (if not provided, will clone)"
    )

    args = parser.parse_args()

    if args.repo_path:
        if not os.path.exists(args.repo_path):
            raise FileNotFoundError(f"Repository path does not exist: {args.repo_path}")
        repo_path = args.repo_path
        cleanup_repo = False
    else:
        # Create temporary directory and clone repo
        temp_dir = tempfile.mkdtemp()
        repo_path = clone_pytorch_repo(temp_dir)
        cleanup_repo = True

    try:
        # Scan for owner_label information
        results = scan_test_files(repo_path)

        # Create final JSON structure with timestamp
        output_data = [
            {"file": r["file"], "owner_labels": r["owner_labels"], "timestamp": int(time.time())} for r in results
        ]

        # Write results to JSON file
        with open(args.output, 'w', encoding='utf-8') as f:
            for entry in output_data:
                json.dump(entry, f)
                f.write('\n')

        print(f"\nFound {len(results)} files with owner_label information.")
        print(f"Results written to {args.output}")

        # Print summary
        if results:
            print("\nSample entries:")
            for result in results[:5]:  # Show first 5 entries
                print(f"  {result['file']}: {result['owner_labels']}")
            if len(results) > 5:
                print(f"  ... and {len(results) - 5} more")

    finally:
        # Clean up temporary directory if we created it
        if cleanup_repo:
            import shutil
            shutil.rmtree(os.path.dirname(repo_path))
            print(f"Cleaned up temporary directory")


if __name__ == "__main__":
    main()
