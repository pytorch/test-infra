import pathlib
import textwrap

from api.config import load_config_with_status


def test_top_level_include_exclude_are_accepted(tmp_path: pathlib.Path) -> None:
    # Write YAML with top-level include/exclude instead of nested paths
    yml = textwrap.dedent(
        """
        version: 1
        include: ["src/**/*.py"]
        exclude: ["**/tests/**", ".*/**"]
        """
    )
    (tmp_path / ".bc-linter.yml").write_text(yml)

    cfg, status = load_config_with_status(tmp_path)
    assert status == "parsed"
    assert cfg.include == ["src/**/*.py"]
    assert cfg.exclude == ["**/tests/**", ".*/**"]


def test_nested_paths_prefer_paths_over_top_level(tmp_path: pathlib.Path) -> None:
    yml = textwrap.dedent(
        """
        version: 1
        include: ["top/**/*.py"]
        exclude: ["**/ignore-me/**"]
        paths:
          include: ["src/**/*.py"]
          exclude: ["**/tests/**"]
        """
    )
    (tmp_path / ".bc-linter.yml").write_text(yml)

    cfg, status = load_config_with_status(tmp_path)
    assert status == "parsed"
    # Should prefer the nested `paths` values
    assert cfg.include == ["src/**/*.py"]
    assert cfg.exclude == ["**/tests/**"]


def test_missing_config_defaults(tmp_path: pathlib.Path) -> None:
    cfg, status = load_config_with_status(tmp_path)
    assert status == "default_missing"
    # defaults
    assert cfg.version == 1
    assert cfg.include == ["**/*.py"]
    assert cfg.exclude == [".*", ".*/**", "**/.*/**", "**/.*"]
    assert cfg.scan.functions is True
    assert cfg.scan.classes is True
    assert cfg.scan.public_only is True
    assert cfg.annotations_include == []
    assert cfg.annotations_exclude == []
    assert cfg.excluded_violations == []


def test_empty_config_defaults(tmp_path: pathlib.Path) -> None:
    (tmp_path / ".bc-linter.yml").write_text("")
    cfg, status = load_config_with_status(tmp_path)
    assert status == "default_error"
    assert cfg.include == ["**/*.py"]
    assert cfg.exclude == [".*", ".*/**", "**/.*/**", "**/.*"]


def test_invalid_yaml_defaults(tmp_path: pathlib.Path) -> None:
    (tmp_path / ".bc-linter.yml").write_text("version: [1, 2\n")  # broken yaml
    cfg, status = load_config_with_status(tmp_path)
    assert status == "default_error"
    assert cfg.include == ["**/*.py"]
    assert cfg.exclude == [".*", ".*/**", "**/.*/**", "**/.*"]


def test_paths_include_exclude_string_and_list(tmp_path: pathlib.Path) -> None:
    yml = """
    version: 1
    paths:
      include: "src/**/*.py"
      exclude:
        - "**/gen/**"
        - ".*/**"
    """
    (tmp_path / ".bc-linter.yml").write_text(yml)
    cfg, status = load_config_with_status(tmp_path)
    assert status == "parsed"
    assert cfg.include == ["src/**/*.py"]
    assert cfg.exclude == ["**/gen/**", ".*/**"]


def test_scan_flags_parsed(tmp_path: pathlib.Path) -> None:
    yml = """
    version: 1
    scan:
      functions: false
      classes: true
      public_only: false
    """
    (tmp_path / ".bc-linter.yml").write_text(yml)
    cfg, status = load_config_with_status(tmp_path)
    assert status == "parsed"
    assert cfg.scan.functions is False
    assert cfg.scan.classes is True
    assert cfg.scan.public_only is False


def test_annotations_and_excluded_violations(tmp_path: pathlib.Path) -> None:
    yml = """
    version: 1
    annotations:
      include:
        - "forced"
        - name: "force_class"
          propagate_to_members: true
      exclude:
        - name: "skip"
        - "skip2"
    excluded_violations: ["ClassDeleted", "ParameterRenamed"]
    """
    (tmp_path / ".bc-linter.yml").write_text(yml)
    cfg, status = load_config_with_status(tmp_path)
    assert status == "parsed"
    # include
    assert len(cfg.annotations_include) == 2
    assert cfg.annotations_include[0].name == "forced"
    assert cfg.annotations_include[0].propagate_to_members is False
    assert cfg.annotations_include[1].name == "force_class"
    assert cfg.annotations_include[1].propagate_to_members is True
    # exclude
    assert len(cfg.annotations_exclude) == 2
    assert cfg.annotations_exclude[0].name == "skip"
    assert cfg.annotations_exclude[0].propagate_to_members is False
    assert cfg.annotations_exclude[1].name == "skip2"
    assert cfg.annotations_exclude[1].propagate_to_members is False
    # excluded violations
    assert cfg.excluded_violations == ["ClassDeleted", "ParameterRenamed"]


def test_warn_on_unknown_top_level_keys(tmp_path: pathlib.Path, capsys) -> None:
    yml = """
    version: 1
    paths:
      include: ["**/*.py"]
    # introduce unknown top-level key
    typpo: 123
    """
    (tmp_path / ".bc-linter.yml").write_text(yml)
    _, status = load_config_with_status(tmp_path)
    assert status == "parsed"
    out = capsys.readouterr().out
    assert "::warning::BC-linter: Unknown keys in .bc-linter.yml: ['typpo']" in out
