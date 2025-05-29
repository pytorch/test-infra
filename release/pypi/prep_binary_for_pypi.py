#!/usr/bin/env python3

"""
Preps binaries for publishing to PyPI by removing the version suffix normally added for binaries.

Usage:
$ python prep_binary_for_pypi_auditwheel.py <path_to_whl_file> [<path_to_more_whl_files>...]

Uses auditwheel for wheel manipulation and will output wheels in your current directory
"""

import argparse
import os
import shutil
import sys
import tempfile
from pathlib import Path


def process_wheel(whl_file, output_dir=None):
    # Check if auditwheel is installed
    try:
        from auditwheel.wheeltools import InWheelCtx
    except ImportError:
        print(
            "Error: auditwheel package is not installed. Install it with 'pip install auditwheel'."
        )
        sys.exit(1)

    """Process a single wheel file to remove version suffixes"""
    if output_dir is None:
        output_dir = os.getcwd()

    # Convert to absolute paths
    whl_file = Path(os.path.abspath(whl_file))
    output_dir = Path(os.path.abspath(output_dir))

    # Create a temporary directory for working
    with tempfile.TemporaryDirectory() as tmp_dir:
        # Open the wheel using auditwheel's tools
        print(f"Processing wheel: {whl_file}")
        tmp_whl = os.path.join(tmp_dir, whl_file)

        # Use InWheelCtx to work with the wheel contents directly
        with InWheelCtx(whl_file) as ctx:
            ctx.out_wheel = tmp_whl
            # Find the .dist-info directory
            dist_info_dirs = [
                d
                for d in os.listdir(ctx.path)
                if d.endswith(".dist-info") and os.path.isdir(os.path.join(ctx.path, d))
            ]

            if not dist_info_dirs:
                print(f"Error: No .dist-info directory found in {whl_file}")
                return

            dist_info_dir = dist_info_dirs[0]

            # Read the metadata to get version info
            metadata_file = os.path.join(ctx.path, dist_info_dir, "METADATA")
            if not os.path.exists(metadata_file):
                print(f"Error: METADATA file not found in {whl_file}")
                return

            # Extract version with suffix
            version_with_suffix = None
            with open(metadata_file, "r", encoding="utf-8") as f:
                for line in f:
                    if line.startswith("Version:"):
                        version_with_suffix = line.split(":", 1)[1].strip()
                        break

            if not version_with_suffix:
                print(f"Error: Could not find version in {metadata_file}")
                return

            # Check if there's a suffix to remove
            if "+" not in version_with_suffix:
                print(f"No suffix found in version {version_with_suffix}, skipping")
                return

            # Remove suffix from version
            version_no_suffix = version_with_suffix.split("+")[0]
            print(f"Removing suffix: {version_with_suffix} -> {version_no_suffix}")

            # Update version in all files in dist-info
            for root, _dirs, files in os.walk(os.path.join(ctx.path, dist_info_dir)):
                for file in files:
                    file_path = os.path.join(root, file)
                    try:
                        with open(
                            file_path, "r", encoding="utf-8", errors="ignore"
                        ) as f:
                            content = f.read()

                        # Replace version with suffix to version without suffix
                        updated_content = content.replace(
                            version_with_suffix, version_no_suffix
                        )

                        if content != updated_content:
                            with open(file_path, "w", encoding="utf-8") as f:
                                f.write(updated_content)
                    except UnicodeDecodeError:
                        # Skip binary files
                        pass

            # Rename the dist-info directory
            new_dist_info_dir = dist_info_dir.replace(
                version_with_suffix, version_no_suffix
            )
            if new_dist_info_dir != dist_info_dir:
                print(f"Renaming {new_dist_info_dir}")
                os.rename(
                    os.path.join(ctx.path, dist_info_dir),
                    os.path.join(ctx.path, new_dist_info_dir),
                )

            # Let auditwheel handle recreating the RECORD file when the context exits
            pass

        # Get the original wheel filename
        wheel_filename = os.path.basename(whl_file)

        # Create the new filename with updated version
        version_with_suffix_escaped = version_with_suffix.replace("+", "%2B")
        new_wheel_filename = wheel_filename.replace(
            version_with_suffix_escaped, version_no_suffix
        )

        # The wheel will be created in the same directory as the original
        # Move it to the requested output directory if needed
        output_wheel = os.path.join(output_dir, new_wheel_filename)

        if os.path.exists(tmp_whl):
            shutil.move(tmp_whl, output_wheel)
            print(f"Successfully created: {output_wheel}")
        else:
            print(f"Error: Could not find created wheel at {tmp_whl}")


def main():
    parser = argparse.ArgumentParser(
        description="Prepare wheel files for PyPI by removing version suffixes."
    )
    parser.add_argument("wheel_files", nargs="+", help="Path to wheel files")
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory to output processed wheels (default: current directory)",
    )

    args = parser.parse_args()
    output_dir = args.output_dir or os.getcwd()
    os.makedirs(output_dir, exist_ok=True)

    for whl_file in args.wheel_files:
        if not os.path.exists(whl_file):
            print(f"Error: Wheel file not found: {whl_file}")
            continue
        try:
            process_wheel(whl_file, output_dir)
        except Exception as e:
            print(f"Error processing {whl_file}: {e}")


if __name__ == "__main__":
    main()
