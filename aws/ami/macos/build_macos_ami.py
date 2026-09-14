#!/usr/bin/env python3
"""
Allocate (or reuse) an EC2 Dedicated Host for Mac, run `packer build` against
it, then optionally release the host.

Mac dedicated hosts have a 24-hour minimum allocation period, so the cost-
efficient workflow is to allocate one host, run multiple builds against it
(e.g. one per macOS version), then release.

Between builds the host enters a "scrubbing" state for ~1-2 hours after each
instance terminates; this script polls `describe-hosts` until the host is
`available` again before kicking off the next packer build.

Host discovery order
--------------------

If --host-id is not given, the driver searches for an existing Dedicated Host
tagged Name=packer-macos-arm64-builder in the chosen region. The first idle
match (state=available, no instances) is reused. If none is found, a fresh
host is allocated with that same tag. Use --no-reuse to force allocation, or
--host-id to override discovery entirely.

Examples
--------

Build a single Sonoma arm64 image, reusing or allocating a host as needed:

    AWS_PROFILE=fbossci python build_macos_ami.py \\
        --region us-east-2 \\
        --macos-version 14

Build Sonoma + Sequoia + Tahoe back-to-back on the same host (one host-day
amortized across three AMIs):

    AWS_PROFILE=fbossci python build_macos_ami.py \\
        --region us-east-2 \\
        --macos-version 14 --macos-version 15 --macos-version 26

Force a fresh host even if a tagged one already exists:

    AWS_PROFILE=fbossci python build_macos_ami.py \\
        --region us-east-2 --macos-version 14 --no-reuse

Pin to a specific host:

    AWS_PROFILE=fbossci python build_macos_ami.py \\
        --host-id h-0123456789abcdef0 \\
        --region us-east-2 --macos-version 14
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional


try:
    import boto3
except ImportError:
    sys.exit("boto3 is required: pip install boto3")

HERE = Path(__file__).resolve().parent

# Apple Silicon only. The resulting AMI is portable across every Mac2 family,
# so building on mac2.metal (cheapest M1 host) covers M1/M2/M2-Pro/M4 fleets.
INSTANCE_TYPE = "mac2.metal"

# Tag value used to discover (and tag) hosts managed by this driver. Any host
# carrying Name=<this value> is a candidate for reuse.
HOST_NAME_TAG = "packer-macos-arm64-builder"

# Poll cadence for waiting on host state.
POLL_INTERVAL_SECONDS = 60
# Generous upper bound for scrubbing window between builds (~2h observed).
HOST_AVAILABLE_TIMEOUT_SECONDS = 4 * 60 * 60


def log(msg: str) -> None:
    print(f"[build_macos_ami] {msg}", flush=True)


def allocate_host(
    ec2,
    instance_type: str,
    availability_zone: str,
    tags: dict[str, str],
) -> str:
    log(
        f"Allocating Dedicated Host: instance-type={instance_type} az={availability_zone}"
    )
    resp = ec2.allocate_hosts(
        AvailabilityZone=availability_zone,
        InstanceType=instance_type,
        AutoPlacement="off",
        Quantity=1,
        TagSpecifications=[
            {
                "ResourceType": "dedicated-host",
                "Tags": [{"Key": k, "Value": v} for k, v in tags.items()],
            }
        ],
    )
    host_id = resp["HostIds"][0]
    log(f"Allocated host {host_id}")
    return host_id


def release_host(ec2, host_id: str) -> None:
    log(f"Releasing host {host_id}")
    resp = ec2.release_hosts(HostIds=[host_id])
    successful = resp.get("Successful", [])
    unsuccessful = resp.get("Unsuccessful", [])
    if unsuccessful:
        for entry in unsuccessful:
            log(f"  unsuccessful: {entry}")
    if successful:
        log(f"  released: {successful}")


def describe_host(ec2, host_id: str) -> dict:
    resp = ec2.describe_hosts(HostIds=[host_id])
    hosts = resp.get("Hosts", [])
    if not hosts:
        raise RuntimeError(f"Host {host_id} not found")
    return hosts[0]


def find_reusable_host(ec2, name_tag: str = HOST_NAME_TAG) -> Optional[str]:
    """
    Look for an existing Dedicated Host tagged Name=<name_tag> in the current
    region. Released hosts are excluded by AWS automatically. Among live hosts
    we prefer one in 'available' state with no running instances; otherwise
    any non-released host (since the caller will wait for it to become idle).
    Returns None if nothing usable is found.
    """
    resp = ec2.describe_hosts(
        Filter=[{"Name": "tag:Name", "Values": [name_tag]}],
    )
    terminal_states = {"released", "released-permanent-failure", "permanent-failure"}
    hosts = [h for h in resp.get("Hosts", []) if h["State"] not in terminal_states]
    if not hosts:
        return None

    def rank(h: dict) -> tuple[int, int]:
        # Lower is better. Prefer idle (state=available + no instances) hosts.
        state_score = 0 if h["State"] == "available" else 1
        instance_score = 0 if not h.get("Instances") else 1
        return (state_score, instance_score)

    hosts.sort(key=rank)
    chosen = hosts[0]
    log(
        f"Reusing existing host {chosen['HostId']} "
        f"(state={chosen['State']}, instances={len(chosen.get('Instances', []))}, "
        f"az={chosen['AvailabilityZone']}, tag Name={name_tag})"
    )
    if len(hosts) > 1:
        others = ", ".join(h["HostId"] for h in hosts[1:])
        log(f"  (also found, not chosen: {others})")
    return chosen["HostId"]


def wait_for_host_available(
    ec2, host_id: str, timeout_s: int = HOST_AVAILABLE_TIMEOUT_SECONDS
) -> None:
    """
    Wait until host State == 'available' and no instance is running on it.
    After an instance terminates the host can spend up to ~2h in 'pending' /
    'under-assessment' (scrubbing) before it accepts a new launch.
    """
    deadline = time.monotonic() + timeout_s
    last_state = None
    while True:
        host = describe_host(ec2, host_id)
        state = host["State"]
        running = len(host.get("Instances", []))
        if state != last_state:
            log(f"Host {host_id} state={state} instances={running}")
            last_state = state
        if state == "available" and running == 0:
            return
        if state in {"permanent-failure", "released", "released-permanent-failure"}:
            raise RuntimeError(f"Host {host_id} entered terminal state {state}")
        if time.monotonic() > deadline:
            raise TimeoutError(
                f"Host {host_id} did not reach 'available' within {timeout_s}s (last state: {state})"
            )
        time.sleep(POLL_INTERVAL_SECONDS)


def run_packer_init(packer_dir: Path) -> None:
    log("Running packer init")
    subprocess.run(["packer", "init", "."], cwd=packer_dir, check=True)


def run_packer_build(
    packer_dir: Path,
    *,
    host_id: str,
    availability_zone: str,
    macos_version: str,
    instance_type: str,
    region: str,
    skip_create_ami: bool,
    extra_args: list[str],
) -> None:
    cmd = [
        "packer",
        "build",
        f"-var=host_id={host_id}",
        f"-var=availability_zone={availability_zone}",
        f"-var=macos_version={macos_version}",
        f"-var=instance_type={instance_type}",
        f"-var=region={region}",
        f"-var=skip_create_ami={'true' if skip_create_ami else 'false'}",
        *extra_args,
        ".",
    ]
    log("Running: " + " ".join(cmd))
    subprocess.run(cmd, cwd=packer_dir, check=True)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--macos-version",
        action="append",
        required=True,
        help="macOS major version to build (e.g. 14, 15, 26). Repeat for multiple builds on the same host.",
    )
    p.add_argument(
        "--region",
        default=os.environ.get("AWS_REGION", "us-east-1"),
        help="AWS region (default: us-east-1).",
    )
    p.add_argument(
        "--availability-zone",
        default="us-east-1a",
        help="Availability zone for host allocation (default: us-east-1a).",
    )
    p.add_argument(
        "--host-id",
        help="Reuse a specific Dedicated Host (h-...) instead of discovering or allocating one.",
    )
    p.add_argument(
        "--no-reuse",
        action="store_true",
        help="Do not search for an existing host tagged Name="
        + HOST_NAME_TAG
        + "; allocate a fresh one.",
    )
    p.add_argument(
        "--release-after",
        action="store_true",
        help=(
            "Release the host after all builds complete. WARNING: Mac hosts are "
            "billed for a minimum of 24h regardless. Default: keep host."
        ),
    )
    p.add_argument(
        "--skip-create-ami",
        action="store_true",
        help="Run the packer provisioners but do not register an AMI (smoke test).",
    )
    p.add_argument(
        "--packer-dir",
        type=Path,
        default=HERE,
        help="Directory containing the packer template (default: this script's directory).",
    )
    p.add_argument(
        "--packer-extra-arg",
        action="append",
        default=[],
        help="Extra argument to pass through to `packer build` (repeatable).",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()

    if shutil.which("packer") is None:
        sys.exit(
            "`packer` not found on PATH. Install from https://www.packer.io/downloads"
        )

    ec2 = boto3.client("ec2", region_name=args.region)

    allocated_by_us = False
    host_id = args.host_id
    if host_id is None and not args.no_reuse:
        host_id = find_reusable_host(ec2)
    if host_id is None:
        host_id = allocate_host(
            ec2,
            instance_type=INSTANCE_TYPE,
            availability_zone=args.availability_zone,
            tags={
                "Name": HOST_NAME_TAG,
                "ManagedBy": "build_macos_ami.py",
            },
        )
        allocated_by_us = True

    # The launch AZ must match the host's AZ. Source it from the host itself
    # rather than the --availability-zone flag, which only applies at allocation.
    host_az = describe_host(ec2, host_id)["AvailabilityZone"]
    log(f"Host {host_id} lives in {host_az}; pinning Packer launch to that AZ")

    try:
        run_packer_init(args.packer_dir)

        for idx, version in enumerate(args.macos_version):
            if idx > 0:
                log(
                    f"Waiting for host {host_id} to finish scrubbing before next build..."
                )
            wait_for_host_available(ec2, host_id)
            log(f"=== Building macOS {version} (arm64) on host {host_id} ===")
            run_packer_build(
                args.packer_dir,
                host_id=host_id,
                availability_zone=host_az,
                macos_version=version,
                instance_type=INSTANCE_TYPE,
                region=args.region,
                skip_create_ami=args.skip_create_ami,
                extra_args=args.packer_extra_arg,
            )
    finally:
        if args.release_after:
            if not allocated_by_us:
                log(
                    f"--release-after set but host {host_id} was passed in; releasing anyway"
                )
            try:
                wait_for_host_available(ec2, host_id)
            except Exception as exc:
                log(f"Could not wait for host to be idle before release: {exc}")
            release_host(ec2, host_id)
        else:
            log(
                f"Host {host_id} left allocated. Re-use with --host-id {host_id}, or release with:"
            )
            log(f"  aws ec2 release-hosts --host-ids {host_id} --region {args.region}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
