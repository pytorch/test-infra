"""The index bundle: one uncompressed tar of the unit embeddings, their tests and the model.

`verify` and the `verify` command use the standard library only, so they run before
any dependency is installed.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime
import hashlib
import io
import json
import os
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, IO, Iterator, Optional, Sequence, TYPE_CHECKING


if TYPE_CHECKING:
    import numpy as np
    from torchci.td.llm.models import ModelSpec


FORMAT_VERSION = 1
META = "meta.json"
EMBEDDINGS = "embeddings.npy"
TESTS = "tests.json"
DATA = (EMBEDDINGS, TESTS)
MODEL_DIR = "model"
MAX_MEMBERS = 200
MAX_META_BYTES = 1024 * 1024
MAX_DATA_BYTES = 2 * 1024**3
MAX_MODEL_FILE_BYTES = 20 * 1024**3
MAX_LICENSE_BYTES = 1024 * 1024
COPY_BLOCK = 1024 * 1024
LICENSE_TEXT = Path(__file__).with_name("LICENSE-MODELS")


class BundleError(Exception):
    pass


@contextlib.contextmanager
def atomic_file(path: Path, mode: str = "wb") -> Iterator[IO[Any]]:
    """A new file that replaces path, fsynced, only when the block completes."""
    if mode not in ("w", "wb"):
        raise ValueError(f"atomic_file writes only, not mode {mode!r}")
    path = Path(path)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        encoding = None if "b" in mode else "utf-8"
        with os.fdopen(fd, mode, encoding=encoding) as f:
            yield f
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def load_npy_checked(
    path: Path,
    dtype: Any,
    rows: Optional[int] = None,
    dim: Optional[int] = None,
) -> np.ndarray:
    """A 2-D C-ordered array of exactly dtype, its header checked before any data is
    read: shape against rows and dim when given, header plus data against the file
    size. Raises ValueError, also for values that are not finite."""
    import numpy as np

    expected = np.dtype(dtype)
    size = Path(path).stat().st_size
    with open(path, "rb") as f:
        version = np.lib.format.read_magic(f)
        if version == (1, 0):
            shape, fortran, found = np.lib.format.read_array_header_1_0(f)
        elif version == (2, 0):
            shape, fortran, found = np.lib.format.read_array_header_2_0(f)
        else:
            raise ValueError(f"{path} has unsupported .npy version {version}")
        header_size = f.tell()
    if found != expected or fortran:
        raise ValueError(f"{path} is not a C-ordered {expected.str} array")
    if (
        len(shape) != 2
        or not all(type(n) is int and n >= 0 for n in shape)
        or (rows is not None and shape[0] != rows)
        or (dim is not None and shape[1] != dim)
    ):
        raise ValueError(f"{path} has shape {shape}, expected ({rows}, {dim})")
    if header_size + shape[0] * shape[1] * expected.itemsize != size:
        raise ValueError(f"{path} size does not match its header")
    array = np.load(path, allow_pickle=False)
    if not np.isfinite(array).all():
        raise ValueError(f"{path} holds non-finite values")
    return array


@dataclass(frozen=True)
class Bundle:
    embeddings: np.ndarray
    tests: list[str]
    meta: dict[str, Any]
    spec: ModelSpec
    model_dir: Path


def _members(tar: tarfile.TarFile) -> Iterator[tarfile.TarInfo]:
    """Members in order: meta.json first, plain regular files only, no duplicates.

    An invalid header past the first member ends tarfile's iteration silently, so
    callers must also require every expected member.
    """
    seen = set()
    for count, member in enumerate(tar):
        if count >= MAX_MEMBERS:
            raise BundleError(f"more than {MAX_MEMBERS} members")
        # tarfile applies a global pax "size" to every later member after locating
        # its data, so such a member reads past its own data.
        if tar.pax_headers:
            raise BundleError("global pax headers are not allowed")
        if count == 0 and member.name != META:
            raise BundleError(f"the first member is {member.name!r}, not {META}")
        if member.name in seen:
            raise BundleError(f"duplicate member {member.name!r}")
        if (
            member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE)
            or member.issparse()
            or any(key.startswith("GNU.sparse") for key in member.pax_headers)
        ):
            raise BundleError(f"member {member.name!r} is not a plain regular file")
        seen.add(member.name)
        yield member


def _read_meta(tar: tarfile.TarFile, member: tarfile.TarInfo) -> dict[str, Any]:
    if member.size > MAX_META_BYTES:
        raise BundleError(f"{META} is over {MAX_META_BYTES} bytes")
    source = tar.extractfile(member)
    assert source is not None
    meta = json.loads(source.read())
    hashes = meta.get("sha256") if isinstance(meta, dict) else None
    if not isinstance(hashes, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in hashes.items()
    ):
        raise BundleError(f"{META} has no sha256 map of member names to hashes")
    return meta


def _compare_hashes(hashes: dict[str, str], found: dict[str, str]) -> None:
    for name in sorted(set(hashes) | set(found)):
        if name not in found:
            raise BundleError(f"member {name!r} is missing")
        if name not in hashes:
            raise BundleError(f"{META} has no sha256 for member {name!r}")
        if hashes[name] != found[name]:
            raise BundleError(f"member {name!r} does not match its sha256")


def verify(path: Path) -> dict[str, Any]:
    """Check member names and hashes against meta.json; return meta.json."""
    found: dict[str, str] = {}
    meta = None
    try:
        with tarfile.open(path, "r:") as tar:
            for member in _members(tar):
                if meta is None:
                    meta = _read_meta(tar, member)
                    continue
                cap = MAX_DATA_BYTES if member.name in DATA else MAX_MODEL_FILE_BYTES
                if member.size > cap:
                    raise BundleError(f"member {member.name!r} is over its size cap")
                source = tar.extractfile(member)
                assert source is not None
                found[member.name] = hashlib.file_digest(source, "sha256").hexdigest()
    except (OSError, tarfile.TarError, ValueError, RecursionError) as e:
        raise BundleError(f"cannot read {path}: {e}") from None
    if meta is None:
        raise BundleError(f"{path} has no members")
    for name in DATA:
        if name not in meta["sha256"]:
            raise BundleError(f"{META} has no sha256 for member {name!r}")
    _compare_hashes(meta["sha256"], found)
    return meta


def _int_field(meta: dict[str, Any], key: str) -> int:
    value = meta.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise BundleError(f"{META} field {key} is not a non-negative integer")
    return value


def _spec_for(meta: dict[str, Any]) -> ModelSpec:
    from torchci.td.llm.models import MODELS, require_files

    version = meta.get("format")
    if isinstance(version, bool) or version != FORMAT_VERSION:
        raise BundleError(f"unsupported bundle format {version!r}")
    key = meta.get("model_key")
    spec = MODELS.get(key) if isinstance(key, str) else None
    if spec is None:
        raise BundleError(f"model {key!r} is not in the registry")
    require_files(spec)
    return spec


def _model_names(spec: ModelSpec) -> dict[str, int]:
    """Bundle member name -> size cap, for every model member."""
    from torchci.td.llm.models import LICENSE_NAME

    names = {f"{MODEL_DIR}/{LICENSE_NAME}": MAX_LICENSE_BYTES}
    names.update({f"{MODEL_DIR}/{rel}": size for rel, (_, size) in spec.files.items()})
    return names


def _extract(tar: tarfile.TarFile, member: tarfile.TarInfo, target: Path) -> str:
    """Stream one member into a new file and return the sha256 of what was written."""
    source = tar.extractfile(member)
    assert source is not None
    target.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    with open(target, "xb") as out:
        while block := source.read(COPY_BLOCK):
            digest.update(block)
            out.write(block)
    return digest.hexdigest()


def read(path: Path, dest: Path) -> Bundle:
    """Extract and check a bundle into the empty directory dest."""
    from torchci.td.llm.models import SnapshotError, verify_snapshot

    dest = Path(dest)
    found: dict[str, str] = {}
    meta = None
    try:
        if dest.exists() and any(dest.iterdir()):
            raise BundleError(f"extraction directory {dest} is not empty")
        dest.mkdir(parents=True, exist_ok=True)
        with tarfile.open(path, "r:") as tar:
            for member in _members(tar):
                if meta is None:
                    meta = _read_meta(tar, member)
                    spec = _spec_for(meta)
                    caps = {name: MAX_DATA_BYTES for name in DATA}
                    caps.update(_model_names(spec))
                    continue
                if member.name not in caps:
                    raise BundleError(f"unexpected member {member.name!r}")
                if member.size > caps[member.name]:
                    raise BundleError(f"member {member.name!r} is over its size cap")
                target = dest.joinpath(*member.name.split("/"))
                found[member.name] = _extract(tar, member, target)
        if meta is None:
            raise BundleError(f"{path} has no members")
        _compare_hashes(meta["sha256"], found)
        missing = sorted(set(caps) - set(found))
        if missing:
            raise BundleError(f"member {missing[0]!r} is missing")
        model_dir = dest / MODEL_DIR
        verify_snapshot(spec, model_dir)
        if meta.get("query_prompt") != spec.query_prompt:
            raise BundleError(f"{META} query_prompt differs from the registry")
        if meta.get("max_tokens") != spec.max_tokens:
            raise BundleError(f"{META} max_tokens differs from the registry")
        rows, dim = _int_field(meta, "rows"), _int_field(meta, "dim")
        tests = json.loads((dest / TESTS).read_text(encoding="utf-8"))
        if not isinstance(tests, list) or not all(isinstance(t, str) for t in tests):
            raise BundleError(f"{TESTS} is not a list of test names")
        if len(tests) != rows:
            raise BundleError(f"{TESTS} has {len(tests)} names for {rows} rows")
        embeddings = load_npy_checked(dest / EMBEDDINGS, "<f2", rows, dim)
    except (OSError, tarfile.TarError, ValueError, RecursionError, SnapshotError) as e:
        raise BundleError(f"invalid bundle {path}: {e}") from None
    return Bundle(embeddings.astype("float32"), tests, meta, spec, model_dir)


def _add_bytes(tar: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = 0o644
    tar.addfile(info, io.BytesIO(data))


def _add_file(tar: tarfile.TarFile, name: str, path: Path) -> None:
    info = tarfile.TarInfo(name)
    info.size = path.stat().st_size
    info.mode = 0o644
    with open(path, "rb") as f:
        tar.addfile(info, f)


def write(
    path: Path,
    embeddings: np.ndarray,
    tests: Sequence[str],
    spec: ModelSpec,
    model_dir: Path,
    pytorch_commit: str,
) -> None:
    """Write a bundle to path atomically."""
    import numpy as np
    from torchci.td.llm.models import LICENSE_NAME, verify_snapshot

    with np.errstate(over="ignore"):
        array = np.ascontiguousarray(embeddings, dtype=np.float16)
    if array.ndim != 2 or array.shape[0] != len(tests):
        raise ValueError(f"embeddings of shape {array.shape} for {len(tests)} tests")
    if not np.isfinite(array).all():
        raise ValueError("embeddings hold values that are not finite in float16")
    verify_snapshot(spec, model_dir)
    buffer = io.BytesIO()
    np.lib.format.write_array(buffer, array, allow_pickle=False)
    data = {EMBEDDINGS: buffer.getvalue(), TESTS: json.dumps(list(tests)).encode()}
    if LICENSE_NAME not in spec.files:
        data[f"{MODEL_DIR}/{LICENSE_NAME}"] = LICENSE_TEXT.read_bytes()
    hashes = {name: hashlib.sha256(blob).hexdigest() for name, blob in data.items()}
    for rel, (sha256, _) in spec.files.items():
        hashes[f"{MODEL_DIR}/{rel}"] = sha256
    meta = {
        "format": FORMAT_VERSION,
        "model_key": spec.key,
        "model_revision": spec.revision,
        "query_prompt": spec.query_prompt,
        "max_tokens": spec.max_tokens,
        "rows": int(array.shape[0]),
        "dim": int(array.shape[1]),
        "pytorch_commit": pytorch_commit,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(
            timespec="seconds"
        ),
        "sha256": dict(sorted(hashes.items())),
    }
    with atomic_file(path) as f, tarfile.open(fileobj=f, mode="w:") as tar:
        _add_bytes(tar, META, json.dumps(meta, indent=1).encode())
        for name, blob in data.items():
            _add_bytes(tar, name, blob)
        for rel in sorted(spec.files):
            _add_file(tar, f"{MODEL_DIR}/{rel}", Path(model_dir) / rel)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -P -m torchci.td.llm.bundle")
    commands = parser.add_subparsers(dest="command", required=True)
    verify_parser = commands.add_parser("verify", help="check member hashes")
    verify_parser.add_argument("bundle", type=Path)
    args = parser.parse_args(argv)
    try:
        meta = verify(args.bundle)
    except BundleError as e:
        print(f"invalid bundle: {e}", file=sys.stderr)
        return 1
    print(f"bundle ok: model {meta.get('model_key')}, {meta.get('rows')} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
