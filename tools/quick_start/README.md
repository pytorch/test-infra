# Quick start data

Generates the data behind the install selector on
https://pytorch.org/get-started/locally/ and the third-party accelerator picker
on the Get Started page. This was previously in `pytorch/pytorch.github.io`
(`.github/workflows/update-quick-start-module.yml` and `scripts/`). Only the JSON
is generated here; the website builds its own JavaScript from it.

The generated files are checked in. The `QUICKSTART` lint regenerates them and
fails if they differ from what is committed, so a change to an input (including
`tools/scripts/generate_binary_build_matrix.py`) must include the regenerated
files.

## Update the generated files

Run this from the repository root after changing `tools/scripts/generate_binary_build_matrix.py`,
the generator code in `tools/linter/adapters/quick_start_linter.py`, or a file in `_additional_platforms/` or
`_get_started/additional_platforms/`, and commit what it changes:

```bash
pip install lintrunner==0.12.5   # once
lintrunner init                  # once; installs markdown and pygments for the generators
lintrunner --take QUICKSTART --all-files -a
```

`-a` rewrites `published_versions.json`, `releases.json` and `additional-platforms.json`
in place. Without `-a` the same command only reports which of them are out of date,
which is what CI does. `--all-files` makes it check even when none of the changed
files is an input. Without it, lintrunner checks only the files changed relative
to `main`.

## Layout

| Path | Role |
|---|---|
| `tools/linter/adapters/quick_start_linter.py` | The `QUICKSTART` lint and the source of truth for generating the files below. It runs `tools/scripts/generate_binary_build_matrix.py` for the getting-started matrices and updates `published_versions.json` and `releases.json`, and builds `additional-platforms.json` from the platform inputs. |
| `_additional_platforms/*.json`, `_get_started/additional_platforms/*.md` | Hand-written inputs, one pair per vendor platform. |
| `published_versions.json`, `releases.json`, `additional-platforms.json` | **Generated.** Do not edit by hand. |

The output does not depend on when or where it runs, so the files only change when an
input does.
