# BC Linter Configuration (beta)

This document describes the configuration format for the Stronghold BC linter.
The config enables repo‑specific path selection, rule suppression, and custom
annotations to include/exclude specific APIs.

### Config file location
- By default the linter searches for a `.bc-linter.yml` file at the root of
  the repository being linted.
- Provide an alternative directory with `--config-dir` if the file lives
  somewhere else.
- If the file is missing or empty, defaults are applied (see below).

### Schema (YAML)
```yml
version: 1

paths:
  include:
    - "**/*.py"         # globs of files to consider (default)
  exclude:
    - "**/.*/**"        # exclude hidden directories by default
    - "**/.*"           # exclude hidden files by default

scan:
  functions: true        # check free functions and methods
  classes: true          # check classes/dataclasses
  public_only: true      # ignore names starting with "_" at any level

annotations:
  include:               # decorators that force‑include a symbol
    - name: "bc_linter_include"  # matched by simple name or dotted suffix
      propagate_to_members: false # for classes, include methods/inner classes
  exclude:               # decorators that force‑exclude a symbol
    - name: "bc_linter_skip"     # matched by simple name or dotted suffix
      propagate_to_members: true  # for classes, exclude methods/inner classes

excluded_violations: []  # e.g. ["ParameterRenamed", "FieldTypeChanged"]
```

### Behavior notes
- Regardless of the config, ONLY `.py` files are considered.
- Paths precedence: `annotations.exclude` > `annotations.include` > `paths`.
  Annotations can override file include/exclude rules.
- Name matching for annotations: A decorator matches if either its simple name
  equals the configured `name` (e.g., `@bc_linter_skip`) or if its dotted
  attribute ends with the configured `name` (e.g., `@proj.bc_linter_skip`).
- `public_only`: When true, any symbol whose qualified name contains a component
  that starts with `_` is ignored (e.g., `module._Internal.func`, `Class._m`).
- Rule suppression: `excluded_violations` contains class names from
  `api.violations` to omit from output (e.g., `FieldTypeChanged`).
- Invariants not affected by config:
  - Deleted methods of a deleted class are not double‑reported (only the class).
  - Nested class deletions collapse to the outermost deleted class.
  - Dataclass detection and field inference are unchanged.

### Defaults
If `.bc-linter.yml` is missing or empty, the following defaults apply:

```
version: 1
paths:
  include: ["**/*.py"]
  exclude: [".*", ".*/**", ".*/**/*", "**/.*/**", "**/.*"]
scan:
  functions: true
  classes: true
  public_only: true
annotations:
  include: []
  exclude: []
excluded_violations: []
```
