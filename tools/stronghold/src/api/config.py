"""Configuration loader for the BC linter."""

from __future__ import annotations

import dataclasses
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
        # Exclude hidden paths both at top-level and nested directories
        # Path matching uses pathspec (gitwildmatch), so these patterns will
        # catch top-level and nested dot directories/files.
        default_factory=lambda: [".*", ".*/**", "**/.*/**", "**/.*"]
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


def load_config_with_status(repo_root: pathlib.Path) -> tuple[Config, str]:
    """Loads configuration from `.bc-linter.yml` in the given repository root.

    Returns (config, status) where status is one of:
    - 'parsed'            -> config file existed and parsed successfully
    - 'default_missing'   -> no config file found
    - 'default_error'     -> file existed but YAML missing/invalid or parser unavailable
    """
    cfg_path = repo_root / ".bc-linter.yml"
    if not cfg_path.exists():
        return (default_config(), "default_missing")

    data: dict[str, Any] | None = None
    try:
        import yaml  # type: ignore[import-not-found]

        with cfg_path.open("r", encoding="utf-8") as fh:
            loaded = yaml.safe_load(fh)  # may be None for empty file
            if loaded is None:
                return (default_config(), "default_error")
            assert isinstance(loaded, dict)
            data = loaded  # type: ignore[assignment]
    except Exception:
        # If PyYAML is not available or parsing fails, fall back to defaults.
        return (default_config(), "default_error")

    # Warn on unknown top-level keys to catch typos/misconfigurations.
    _allowed_keys = {
        "version",
        "paths",
        "scan",
        "annotations",
        "excluded_violations",
        # shortcut for top-level support
        "include",
        "exclude",
    }
    _unknown_keys = sorted(set(data.keys()) - _allowed_keys)
    if _unknown_keys:
        print(f"::warning::BC-linter: Unknown keys in .bc-linter.yml: {_unknown_keys}")

    version = int(data.get("version", 1))

    # Accept both nested `paths: {include, exclude}` and top-level
    # `include`/`exclude` keys for convenience.
    raw_paths = data.get("paths")
    paths: dict[str, Any] = {}
    if isinstance(raw_paths, dict):
        paths.update(raw_paths)
    # Fallback: if top-level include/exclude are present, use them unless
    # already provided under `paths`.
    if "include" in data and "include" not in paths:
        paths["include"] = data["include"]
    if "exclude" in data and "exclude" not in paths:
        paths["exclude"] = data["exclude"]
    include = _as_list_str(paths.get("include", ["**/*.py"]))
    exclude = _as_list_str(paths.get("exclude", [".*", ".*/**", "**/.*/**", "**/.*"]))

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

    cfg = Config(
        version=version,
        include=include,
        exclude=exclude,
        scan=scan_spec,
        annotations_include=anns_inc,
        annotations_exclude=anns_exc,
        excluded_violations=excluded_violations,
    )
    return (cfg, "parsed")


def load_config(repo_root: pathlib.Path) -> Config:
    """Loads configuration from `.bc-linter.yml` in the given repository root.

    If the file does not exist or cannot be parsed, returns defaults.
    """
    cfg, _ = load_config_with_status(repo_root)
    return cfg


def match_any(path: pathlib.Path, patterns: Sequence[str]) -> bool:
    """Returns True if the path matches any of the glob patterns.

    Patterns are matched against POSIX-style paths.
    """
    # An empty pattern list should be a no-op (match everything)
    # to allow "include: []" semantics -> do not restrict by include.
    if not patterns:
        return True
    # Require pathspec; no fallback to avoid divergent semantics.
    import pathspec

    spec = pathspec.PathSpec.from_lines("gitwildmatch", patterns)
    return spec.match_file(path.as_posix())
