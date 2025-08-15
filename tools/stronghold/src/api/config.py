"""Configuration loader for the BC linter."""

from __future__ import annotations

import dataclasses
import fnmatch
import pathlib
from typing import Any, Iterable, Sequence


@dataclasses.dataclass
class AnnotationSpec:
    name: str
    propagate_to_members: bool = False


@dataclasses.dataclass
class ScanSpec:
    functions: bool = True
    classes: bool = True
    public_only: bool = True


@dataclasses.dataclass
class Config:
    version: int = 1
    include: Sequence[str] = dataclasses.field(default_factory=lambda: ["**/*.py"])
    exclude: Sequence[str] = dataclasses.field(
        default_factory=lambda: ["**/.*/**", "**/.*"]
    )
    scan: ScanSpec = dataclasses.field(default_factory=ScanSpec)
    annotations_include: Sequence[AnnotationSpec] = dataclasses.field(
        default_factory=list
    )
    annotations_exclude: Sequence[AnnotationSpec] = dataclasses.field(
        default_factory=list
    )
    excluded_violations: Sequence[str] = dataclasses.field(default_factory=list)


def _as_list_str(v: Any) -> list[str]:
    if v is None:
        return []
    if isinstance(v, str):
        return [v]
    if isinstance(v, Iterable):
        return [str(x) for x in v]
    return [str(v)]


def default_config() -> Config:
    return Config()


def load_config(repo_root: pathlib.Path) -> Config:
    """Loads configuration from `.bc-linter.yml` in the given repository root.

    If the file does not exist or cannot be parsed, returns defaults.
    """
    cfg_path = repo_root / ".bc-linter.yml"
    if not cfg_path.exists():
        return default_config()

    data: dict[str, Any] | None = None
    try:
        import yaml  # type: ignore[import-not-found]

        with cfg_path.open("r", encoding="utf-8") as fh:
            loaded = yaml.safe_load(fh)  # may be None for empty file
            if loaded is None:
                return default_config()
            assert isinstance(loaded, dict)
            data = loaded  # type: ignore[assignment]
    except Exception:
        # If PyYAML is not available or parsing fails, fall back to defaults.
        return default_config()

    version = int(data.get("version", 1))

    paths = data.get("paths", {}) or {}
    include = _as_list_str(paths.get("include", ["**/*.py"]))
    exclude = _as_list_str(paths.get("exclude", ["**/.*/**", "**/.*"]))

    scan = data.get("scan", {}) or {}
    scan_spec = ScanSpec(
        functions=bool(scan.get("functions", True)),
        classes=bool(scan.get("classes", True)),
        public_only=bool(scan.get("public_only", True)),
    )

    annotations = data.get("annotations", {}) or {}
    anns_inc_raw = annotations.get("include", []) or []
    anns_exc_raw = annotations.get("exclude", []) or []

    def _ann_list(raw: Any) -> list[AnnotationSpec]:
        out: list[AnnotationSpec] = []
        if isinstance(raw, dict):
            raw = [raw]
        if isinstance(raw, list):
            for item in raw:
                if isinstance(item, str):
                    out.append(AnnotationSpec(name=item, propagate_to_members=False))
                elif isinstance(item, dict):
                    out.append(
                        AnnotationSpec(
                            name=str(item.get("name", "")),
                            propagate_to_members=bool(
                                item.get("propagate_to_members", False)
                            ),
                        )
                    )
        return out

    anns_inc = _ann_list(anns_inc_raw)
    anns_exc = _ann_list(anns_exc_raw)

    excluded_violations = _as_list_str(data.get("excluded_violations", []))

    return Config(
        version=version,
        include=include,
        exclude=exclude,
        scan=scan_spec,
        annotations_include=anns_inc,
        annotations_exclude=anns_exc,
        excluded_violations=excluded_violations,
    )


def match_any(path: pathlib.Path, patterns: Sequence[str]) -> bool:
    """Returns True if the path matches any of the glob patterns.

    Patterns are matched against POSIX-style paths.
    """
    posix = path.as_posix()
    return any(fnmatch.fnmatch(posix, pat) for pat in patterns)
