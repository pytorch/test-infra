#!/usr/bin/env python3

import os.path
import shutil
import subprocess
import tempfile
import zipfile
from typing import Optional, TypedDict

import boto3  # type: ignore[import-untyped]
import botocore  # type: ignore[import-untyped]


class WheelMetadata(TypedDict):
    version: Optional[str]
    requires_dist: list[str]
    requires_python: Optional[str]
    programming_classifiers: list[str]


PLATFORMS = [
    "manylinux_2_28_x86_64",
    "manylinux_2_28_aarch64",
    "win_amd64",
    "macosx_11_0_arm64",
]
PYTHON_VERSIONS = ["cp310", "cp311", "cp312", "cp313", "cp313t", "cp314", "cp314t"]
S3_PYPI_STAGING = "pytorch-backup"
PACKAGE_RELEASES = {
    "torch": "2.10.0",
    "torchvision": "0.25.0",
    "torchaudio": "2.10.0",
    # "executorch": "0.2.1",
}

PATTERN_V = "Version:"
PATTERN_RD = "Requires-Dist:"
PATTERN_PYTHON = "Requires-Python:"
PATTERN_PROGRAMMING = "Classifier: Programming Language :: Python ::"

s3 = boto3.client("s3")


def get_size(path):
    size = os.path.getsize(path)
    if size < 1024:
        return f"{size} bytes"
    elif size < pow(1024, 2):
        return f"{round(size / 1024, 2)} KB"
    elif size < pow(1024, 3):
        return f"{round(size / (pow(1024, 2)), 2)} MB"
    elif size < pow(1024, 4):
        return f"{round(size / (pow(1024, 3)), 2)} GB"


def generate_expected_builds(platform: str, package: str, release: str) -> list:
    builds = []
    for py_version in PYTHON_VERSIONS:
        # For free-threaded Python (cp313t, cp314t), the filename pattern is cp3XX-cp3XXt
        if py_version.endswith("t"):
            py_base = py_version[:-1]  # Remove the 't' suffix
            py_spec = f"{py_base}-{py_version}"
        else:
            py_spec = f"{py_version}-{py_version}"
        platform_spec = platform

        # strange macos file nameing
        if "macos" in platform:
            if package == "torch":
                py_spec = f"{py_version}-none"
            elif "macosx_10_9_x86_64" in platform:
                platform_spec = "macosx_10_13_x86_64"

        builds.append(
            f"{package}-{release}-pypi-staging/{package}-{release}-{py_spec}-{platform_spec}.whl"
        )

    return builds


def validate_file_metadata(build: str, package: str, version: str) -> WheelMetadata:
    """Validate wheel metadata and return extracted metadata for comparison."""
    temp_dir = tempfile.mkdtemp()
    tmp_file = f"{temp_dir}/{os.path.basename(build)}"
    s3.download_file(Bucket=S3_PYPI_STAGING, Key=build, Filename=tmp_file)
    print(f"Downloaded: {tmp_file}  {get_size(tmp_file)}")

    metadata: WheelMetadata = {
        "version": None,
        "requires_dist": [],
        "requires_python": None,
        "programming_classifiers": [],
    }

    try:
        check_wheels = subprocess.run(
            ["check-wheel-contents", tmp_file, "--ignore", "W002,W009,W004"],
            capture_output=True,
            text=True,
            check=True,
            encoding="utf-8",
        )
        print(check_wheels.stdout)
        print(check_wheels.stderr)
    except subprocess.CalledProcessError as e:
        exit_code = e.returncode
        stderror = e.stderr
        print(exit_code, stderror)

    with zipfile.ZipFile(tmp_file, "r") as zip_ref:
        zip_ref.extractall(temp_dir)

    with open(f"{temp_dir}/{package}-{version}.dist-info/METADATA") as f:
        for line in f:
            if line.startswith(PATTERN_V):
                print(f"{line}", end="")
                extracted_version = line.removeprefix(PATTERN_V).strip()
                metadata["version"] = extracted_version
                if version != extracted_version:
                    print(
                        f"FAILURE VERSION DOES NOT MATCH expected {version} got {extracted_version}"
                    )
            elif line.startswith(PATTERN_RD):
                print(f"{line}", end="")
                metadata["requires_dist"].append(line.removeprefix(PATTERN_RD).strip())
            elif line.startswith(PATTERN_PYTHON):
                print(f"{line}", end="")
                metadata["requires_python"] = line.removeprefix(PATTERN_PYTHON).strip()
            elif line.startswith(PATTERN_PROGRAMMING):
                print(f"{line}", end="")
                metadata["programming_classifiers"].append(
                    line.removeprefix(PATTERN_PROGRAMMING).strip()
                )

    shutil.rmtree(temp_dir)
    return metadata


def compare_metadata(all_metadata: dict, package: str) -> bool:
    """Compare metadata across all wheels for a package.

    Returns True if all metadata is consistent, False otherwise.
    """
    wheels = list(all_metadata.keys())
    if not wheels:
        print(f"No wheels to compare for {package}")
        return True

    reference_wheel = wheels[0]
    reference = all_metadata[reference_wheel]
    mismatches = []

    print(f"\n{'=' * 60}")
    print(f"Metadata Consistency Check for {package}")
    print(f"{'=' * 60}")
    print(f"Reference wheel: {reference_wheel}")
    print(f"  Version: {reference['version']}")
    print(f"  Requires-Python: {reference['requires_python']}")
    print(f"  Requires-Dist ({len(reference['requires_dist'])} deps):")
    for dep in sorted(reference["requires_dist"]):
        print(f"    - {dep}")
    print(f"  Programming Classifiers: {reference['programming_classifiers']}")

    for wheel in wheels[1:]:
        current = all_metadata[wheel]

        # Compare version
        if current["version"] != reference["version"]:
            mismatches.append(
                f"Version mismatch: {reference_wheel} has '{reference['version']}' "
                f"vs {wheel} has '{current['version']}'"
            )

        # Compare requires_dist (should be same for all wheels of same package)
        ref_deps = sorted(reference["requires_dist"])
        cur_deps = sorted(current["requires_dist"])
        if ref_deps != cur_deps:
            # Find differences
            ref_set = set(reference["requires_dist"])
            cur_set = set(current["requires_dist"])
            only_in_ref = ref_set - cur_set
            only_in_cur = cur_set - ref_set
            diff_msg = f"Requires-Dist mismatch between {reference_wheel} and {wheel}:"
            if only_in_ref:
                diff_msg += f"\n      Only in reference: {only_in_ref}"
            if only_in_cur:
                diff_msg += f"\n      Only in {wheel}: {only_in_cur}"
            mismatches.append(diff_msg)

        # Compare requires_python
        if current["requires_python"] != reference["requires_python"]:
            mismatches.append(
                f"Requires-Python mismatch: {reference_wheel} has '{reference['requires_python']}' "
                f"vs {wheel} has '{current['requires_python']}'"
            )

        # Compare programming classifiers
        ref_classifiers = sorted(reference["programming_classifiers"])
        cur_classifiers = sorted(current["programming_classifiers"])
        if ref_classifiers != cur_classifiers:
            ref_set = set(reference["programming_classifiers"])
            cur_set = set(current["programming_classifiers"])
            only_in_ref = ref_set - cur_set
            only_in_cur = cur_set - ref_set
            diff_msg = f"Programming Classifiers mismatch between {reference_wheel} and {wheel}:"
            if only_in_ref:
                diff_msg += f"\n      Only in reference: {only_in_ref}"
            if only_in_cur:
                diff_msg += f"\n      Only in {wheel}: {only_in_cur}"
            mismatches.append(diff_msg)

    if mismatches:
        print(f"\nMETADATA INCONSISTENCIES FOUND for {package}:")
        for m in mismatches:
            print(f"  - {m}")
        return False
    else:
        print(f"\nAll {len(wheels)} wheels for {package} have consistent metadata")
        return True


def main():
    expected_builds = dict.fromkeys(PACKAGE_RELEASES, [])

    # Iterate over platform to gather build information of available conda version.
    for package in PACKAGE_RELEASES:
        for platform in PLATFORMS:
            expected_builds[package] = expected_builds[
                package
            ] + generate_expected_builds(platform, package, PACKAGE_RELEASES[package])

    all_results = {}  # Track consistency results for final summary

    for package in PACKAGE_RELEASES:
        count = 0
        package_metadata = {}  # Collect metadata for all wheels of this package

        for build in expected_builds[package]:
            try:
                s3.head_object(Bucket=S3_PYPI_STAGING, Key=build)
                print(f"Validating filename {os.path.basename(build)}")
                metadata = validate_file_metadata(
                    build, package, PACKAGE_RELEASES[package]
                )
                package_metadata[os.path.basename(build)] = metadata
                count += 1
            except botocore.exceptions.ClientError as e:
                if e.response["Error"]["Code"] == "404":
                    print(f"FAILED 404 Error on {build}")
                elif e.response["Error"]["Code"] == "403":
                    print(f"FAILED Unauthorized Error on {build}")
                else:
                    print(f"Error on {build}")

        print(f"Package Validated {count} for {package}")

        # Compare metadata across all wheels for this package
        is_consistent = compare_metadata(package_metadata, package)
        all_results[package] = {
            "count": count,
            "consistent": is_consistent,
            "total_expected": len(expected_builds[package]),
        }

    # Print final summary
    print(f"\n{'=' * 60}")
    print("FINAL VALIDATION SUMMARY")
    print(f"{'=' * 60}")
    all_consistent = True
    for package, result in all_results.items():
        status = "CONSISTENT" if result["consistent"] else "INCONSISTENT"
        if not result["consistent"]:
            all_consistent = False
        print(
            f"{package}: {result['count']}/{result['total_expected']} wheels validated, "
            f"metadata {status}"
        )

    if all_consistent:
        print("\nAll packages have consistent metadata across all validated wheels.")
    else:
        print("\nWARNING: Some packages have inconsistent metadata!")
        exit(1)


if __name__ == "__main__":
    main()
