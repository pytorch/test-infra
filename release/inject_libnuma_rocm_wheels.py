#!/usr/bin/env python3
"""
Inject libnuma into already-published ROCm torch wheels.

Hotfix for pytorch/pytorch#195670. rocSHMEM's NUMAWrapper global ctor does
``dlopen("libnuma.so")``; ``torch/lib`` is on ``libtorch_rocshmem.so``'s RPATH
via ``$ORIGIN``, so a bundled copy there satisfies it. The AlmaLinux manywheel
builder had no numactl installed, so ``repair_wheel.py``'s ``rocm_os_deps()``
skipped libnuma silently and the published wheels ship without it. Every
``import torch`` then prints:

    E-001h rocSHMEM Could not open libnuma. Returning  NUMAWrapper@...:48

and per pytorch/pytorch#189110 the failed dlopen can make rocSHMEM ``exit()``
at load, deadlocking ``import torch`` on hosts with no GPU or kfd.

pytorch/pytorch#195672 fixes the builder. This script repairs wheels that were
already published, without a rebuild.

This script:
  1. Discovers torch wheels of a given version on the ROCm channel index.
  2. Downloads each wheel.
  3. Unpacks it with ``wheel unpack`` and adds ``torch/lib/libnuma.so.1`` and
     ``torch/lib/libnuma.so`` from a libnuma the caller supplies. Both are
     written as real files rather than one being a symlink: a correct build
     produces a symlink, but ``wheel unpack``/``pack`` does not round-trip
     symlinks and the two are equivalent to ``dlopen``. Wheels that already
     contain libnuma are left alone, so re-running is safe.
  4. Repacks with ``wheel pack``, which regenerates RECORD (hashes and sizes)
     so the wheel still verifies under ``pip install --require-hashes``.
  5. Verifies the result before uploading (see the ZIP64 note below).
  6. Uploads each wheel back over the original, to S3 and Cloudflare R2, with
     ``x-amz-meta-checksum-sha256`` set so the PEP 503 index picks it up.

ZIP64 caveat, please read:

  ``wheel pack`` is known to emit an invalid ZIP64 header for archives over
  4GB (pypa/wheel#692). ROCm wheels are ~1.4GB compressed but well over 4GB
  unpacked, and pytorch#189748 tracked exactly this: wheels that installed
  under pip but failed under stricter zip parsers such as uv. That is why
  pytorch's own ``.ci/manywheel/repair_wheel.py`` repacks with auditwheel
  instead.

  ``verify_wheel()`` therefore checks the ZIP64 records on every repacked
  archive and refuses to upload if they are malformed. If it trips, repack
  that wheel with auditwheel rather than working around the check.

Supplying libnuma:

  Use one from the same distro family the wheels were built on (AlmaLinux 8,
  glibc 2.28) so the manylinux_2_28 tag stays honest. Do not use the host's
  copy unless the host matches.

      docker run --rm -v "$PWD":/out almalinux:8 bash -c \\
          'yum install -y numactl-libs >/dev/null && \\
           cp -L /usr/lib64/libnuma.so.1 /out/libnuma.so.1'

Disk: each wheel is unpacked in full, so budget ~6GB of scratch per wheel.
Point TMPDIR at real storage; /tmp is often a small tmpfs.

Environment variables:
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
        Required to upload to R2. If missing, the R2 upload is skipped with a
        warning.
  R2_BUCKET_NAME
        R2 bucket name (defaults to ``pytorch-downloads``).

AWS credentials for S3 come from the standard boto3 chain.

Usage:
  python inject_libnuma_rocm_wheels.py --version 2.14.0 --rocm rocm7.14 \\
      --libnuma ./libnuma.so.1 --dry-run
  python inject_libnuma_rocm_wheels.py --version 2.14.0 --rocm rocm7.14 \\
      --libnuma ./libnuma.so.1
"""

import argparse
import hashlib
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path


DEFAULT_PACKAGE = "torch"
DEFAULT_ROCM = "rocm7.14"
DEFAULT_S3_BUCKET = "pytorch"

TARGET_DIR = "torch/lib"
VERSIONED_NAME = "libnuma.so.1"
BARE_NAME = "libnuma.so"

ZIP64_THRESHOLD = 4 * 1024**3


def channel_prefix(channel: str, rocm: str) -> str:
    """Bucket-relative prefix for a channel, e.g. ``whl/test/rocm7.14``."""
    return f"whl/{rocm}" if channel == "release" else f"whl/{channel}/{rocm}"


def discover_wheels(package: str, version: str, channel: str, rocm: str) -> list[str]:
    """Wheel filenames for ``package==version+rocm`` on the channel index."""
    index_url = (
        f"https://download.pytorch.org/{channel_prefix(channel, rocm)}/{package}"
    )
    print(f"+ Fetching index: {index_url}")
    with urllib.request.urlopen(index_url) as resp:
        html = resp.read().decode("utf-8", errors="replace")

    pattern = re.compile(
        rf'href="[^"]*?/({re.escape(package)}-{re.escape(version)}'
        rf'(?:%2B|\+){re.escape(rocm)}-[^"#]+\.whl)'
    )
    found = {urllib.parse.unquote(m.group(1)) for m in pattern.finditer(html)}
    wheels = sorted(found)
    print(f"+ Found {len(wheels)} wheel(s) for {package}=={version}+{rocm}")
    return wheels


def download_wheel(filename: str, channel: str, rocm: str, dest_dir: Path) -> Path:
    url = (
        f"https://download.pytorch.org/{channel_prefix(channel, rocm)}/"
        f"{urllib.parse.quote(filename)}"
    )
    dest = dest_dir / filename
    print(f"+ Downloading {url}")
    with urllib.request.urlopen(url) as resp, open(dest, "wb") as out:
        shutil.copyfileobj(resp, out)
    return dest


def validate_libnuma(path: Path) -> None:
    """Reject anything that is obviously not an x86-64 ELF libnuma."""
    data = path.read_bytes()
    if data[:4] != b"\x7fELF":
        sys.exit(f"{path} is not an ELF file")
    if data[4] != 2:
        sys.exit(f"{path} is not 64-bit")
    # e_machine at offset 18; 0x3e == EM_X86_64.
    if int.from_bytes(data[18:20], "little") != 0x3E:
        sys.exit(f"{path} is not x86-64")
    # Cheap SONAME check: the string lives in .dynstr, so a substring scan is
    # enough to catch the wrong library being passed by mistake.
    if b"libnuma.so.1" not in data:
        sys.exit(f"{path} does not look like libnuma (no libnuma.so.1 string)")
    print(f"+ libnuma source: {path} ({len(data)} bytes)")


def has_libnuma(wheel_path: Path) -> bool:
    with zipfile.ZipFile(wheel_path) as zf:
        return f"{TARGET_DIR}/{BARE_NAME}" in zf.namelist()


def run(cmd: list[str]) -> None:
    print("  $ " + " ".join(cmd))
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)


def inject(wheel_path: Path, libnuma: Path, work: Path, output_dir: Path) -> Path:
    """Unpack, add libnuma, repack with ``wheel pack``. Returns the new wheel."""
    unpack_dir = work / "unpacked"
    if unpack_dir.exists():
        shutil.rmtree(unpack_dir)
    unpack_dir.mkdir()

    run([sys.executable, "-m", "wheel", "unpack", str(wheel_path), "-d", str(unpack_dir)])

    roots = [d for d in unpack_dir.iterdir() if d.is_dir()]
    if len(roots) != 1:
        raise RuntimeError(f"expected one unpacked root, got {roots}")
    root = roots[0]

    lib_dir = root / TARGET_DIR
    if not lib_dir.is_dir():
        raise RuntimeError(f"{TARGET_DIR} not found in {wheel_path.name}")
    for name in (VERSIONED_NAME, BARE_NAME):
        shutil.copy(libnuma, lib_dir / name)
        print(f"  + added {TARGET_DIR}/{name}")

    # wheel pack rewrites RECORD from the tree, so the added files get correct
    # hashes and sizes and --require-hashes keeps working.
    run([sys.executable, "-m", "wheel", "pack", str(root), "-d", str(output_dir)])
    shutil.rmtree(unpack_dir)

    produced = list(output_dir.glob(wheel_path.name))
    if not produced:
        # wheel pack derives the filename from .dist-info, which should match,
        # but fall back to whatever landed rather than failing opaquely.
        produced = sorted(output_dir.glob("*.whl"))
        if not produced:
            raise RuntimeError(f"wheel pack produced nothing for {wheel_path.name}")
    return produced[0]


def verify_wheel(wheel_path: Path) -> None:
    """Confirm the injected libs are present, listed in RECORD, readable, and
    that the ZIP64 records are well formed."""
    with zipfile.ZipFile(wheel_path) as zf:
        names = set(zf.namelist())
        for name in (VERSIONED_NAME, BARE_NAME):
            key = f"{TARGET_DIR}/{name}"
            if key not in names:
                raise RuntimeError(f"{key} missing from repacked {wheel_path.name}")
            # Decompress just the injected members to confirm their CRCs.
            with zf.open(key) as fh:
                while fh.read(1024 * 1024):
                    pass

        record = [n for n in names if n.endswith(".dist-info/RECORD")]
        if not record:
            raise RuntimeError(f"no RECORD in {wheel_path.name}")
        text = zf.read(record[0]).decode()
        for name in (VERSIONED_NAME, BARE_NAME):
            key = f"{TARGET_DIR}/{name}"
            if key not in text:
                raise RuntimeError(f"{key} not listed in RECORD")

    verify_zip64(wheel_path)
    print(f"+ verified {wheel_path.name}")


def verify_zip64(wheel_path: Path) -> None:
    """Guard against pypa/wheel#692: ``wheel pack`` writing a bad ZIP64 header
    on archives over 4GB, which installs under pip but fails under stricter
    parsers such as uv (pytorch#189748)."""
    size = wheel_path.stat().st_size
    with open(wheel_path, "rb") as f:
        f.seek(max(0, size - 200000))
        tail = f.read()

    eocd = tail.rfind(b"PK\x05\x06")
    if eocd < 0:
        raise RuntimeError(f"{wheel_path.name}: no end-of-central-directory record")
    total, cd_size, cd_off = struct.unpack("<HII", tail[eocd + 10 : eocd + 20])

    needs_zip64 = (
        size >= ZIP64_THRESHOLD
        or total == 0xFFFF
        or cd_size == 0xFFFFFFFF
        or cd_off == 0xFFFFFFFF
    )
    if not needs_zip64:
        return

    loc = tail.rfind(b"PK\x06\x07")
    rec = tail.rfind(b"PK\x06\x06")
    if loc < 0 or rec < 0:
        raise RuntimeError(
            f"{wheel_path.name} needs ZIP64 but the ZIP64 "
            f"end-of-central-directory {'locator' if loc < 0 else 'record'} is "
            f"missing (pypa/wheel#692). Repack this wheel with auditwheel."
        )
    (rec_off,) = struct.unpack("<Q", tail[loc + 8 : loc + 16])
    expected = size - (len(tail) - rec)
    if rec_off != expected:
        raise RuntimeError(
            f"{wheel_path.name}: ZIP64 locator points at offset {rec_off} but the "
            f"ZIP64 record is at {expected} (pypa/wheel#692). Repack with auditwheel."
        )
    z64_cd_size, z64_cd_off = struct.unpack("<QQ", tail[rec + 40 : rec + 56])
    if z64_cd_off + z64_cd_size > size:
        raise RuntimeError(
            f"{wheel_path.name}: ZIP64 central directory at {z64_cd_off} "
            f"+{z64_cd_size} overruns the {size}-byte archive (pypa/wheel#692). "
            f"Repack with auditwheel."
        )


def sha256_of(file_path: Path) -> str:
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def upload_to_s3(
    file_path: Path, bucket: str, key: str, sha256: str, dry_run: bool
) -> None:
    if dry_run:
        print(f"+ DRY RUN: would upload to s3://{bucket}/{key} (sha256={sha256})")
        return

    import boto3  # type: ignore[import]

    print(f"+ Uploading to s3://{bucket}/{key}")
    boto3.client("s3").upload_file(
        Filename=str(file_path),
        Bucket=bucket,
        Key=key,
        ExtraArgs={
            "ACL": "public-read",
            "Metadata": {"checksum-sha256": sha256},
        },
    )


def upload_to_r2(
    file_path: Path, bucket: str, key: str, sha256: str, dry_run: bool
) -> None:
    account_id = os.environ.get("R2_ACCOUNT_ID", "")
    access_key = os.environ.get("R2_ACCESS_KEY_ID", "")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    if not (account_id and access_key and secret_key):
        print(
            "- WARNING: R2 credentials not configured "
            "(R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY); "
            "skipping R2 upload"
        )
        return

    if dry_run:
        print(f"+ DRY RUN: would upload to R2 s3://{bucket}/{key} (sha256={sha256})")
        return

    import boto3  # type: ignore[import]

    print(f"+ Uploading to R2 s3://{bucket}/{key}")
    boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    ).upload_file(
        Filename=str(file_path),
        Bucket=bucket,
        Key=key,
        ExtraArgs={"Metadata": {"checksum-sha256": sha256}},
    )


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Inject libnuma into published ROCm torch wheels."
    )
    p.add_argument("--version", required=True, help="torch version, e.g. 2.14.0")
    p.add_argument("--rocm", default=DEFAULT_ROCM, help=f"default {DEFAULT_ROCM}")
    p.add_argument("--package", default=DEFAULT_PACKAGE)
    p.add_argument(
        "--channel",
        default="test",
        choices=["test", "nightly", "release"],
        help="channel to read from and write back to (default test)",
    )
    p.add_argument(
        "--libnuma",
        required=True,
        type=Path,
        help="path to libnuma.so.1 to inject (see module docstring)",
    )
    p.add_argument("--s3-bucket", default=DEFAULT_S3_BUCKET)
    p.add_argument(
        "--r2-bucket", default=os.environ.get("R2_BUCKET_NAME", "pytorch-downloads")
    )
    p.add_argument("--skip-s3", action="store_true")
    p.add_argument("--skip-r2", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    if not args.libnuma.is_file():
        sys.exit(f"--libnuma {args.libnuma} does not exist")
    validate_libnuma(args.libnuma.resolve())

    wheels = discover_wheels(args.package, args.version, args.channel, args.rocm)
    if not wheels:
        print("- No wheels found, nothing to do")
        return 1

    prefix = channel_prefix(args.channel, args.rocm)
    libnuma = args.libnuma.resolve()
    injected = skipped = 0

    with tempfile.TemporaryDirectory() as work_dir:
        work = Path(work_dir)
        out_dir = work / "out"
        out_dir.mkdir()

        for filename in wheels:
            print(f"\n=-=-=-= {filename} =-=-=-=")
            src = download_wheel(filename, args.channel, args.rocm, work)
            try:
                if has_libnuma(src):
                    print(f"+ already has {BARE_NAME}, skipping")
                    skipped += 1
                    continue
                new_wheel = inject(src, libnuma, work, out_dir)
                verify_wheel(new_wheel)
            finally:
                src.unlink(missing_ok=True)

            sha256 = sha256_of(new_wheel)
            key = f"{prefix}/{new_wheel.name}"
            if not args.skip_s3:
                upload_to_s3(new_wheel, args.s3_bucket, key, sha256, args.dry_run)
            if not args.skip_r2:
                upload_to_r2(new_wheel, args.r2_bucket, key, sha256, args.dry_run)
            new_wheel.unlink(missing_ok=True)
            injected += 1

    print(f"\n+ Injected {injected} wheel(s), skipped {skipped} already patched")
    return 0


if __name__ == "__main__":
    sys.exit(main())
