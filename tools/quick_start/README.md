# Quick start module

Generates the data and JavaScript behind the install selector on
https://pytorch.org/get-started/locally/ and the third-party accelerator picker
on the Get Started page. This was previously in `pytorch/pytorch.github.io`
(`.github/workflows/update-quick-start-module.yml` and `scripts/`).

The generated files are checked in. The `QUICK_START` lint (`tools/linter/adapters/quick_start_linter.py`)
regenerates them from the build matrix and the inputs below and fails when they
differ, so a change to `tools/scripts/generate_binary_build_matrix.py`, a platform
file or a generator must be sent together with the regenerated files. Run
`lintrunner --take QUICK_START -a` to update them.

## Layout

| Path | Role |
|---|---|
| `scripts/gen_quick_start_module.py` | Reads the build matrices from `tools/scripts/generate_binary_build_matrix.py` (via the `generate_binary_build_matrix.yml` workflow) and updates `published_versions.json` and `releases.json`. Prints `assets/quick-start-module.js`. |
| `scripts/gen_additional_platforms.py` | Builds `assets/quick-start-additional-platforms.js` and `additional-platforms.json` from `_additional_platforms/*.json` and `_get_started/additional_platforms/*.md`. |
| `_includes/quick-start-module.js`, `_includes/quick-start-additional-platforms.js` | Templates the scripts fill in. |
| `_additional_platforms/*.json`, `_get_started/additional_platforms/*.md` | Hand-written inputs, one pair per vendor platform. |
| `published_versions.json`, `releases.json`, `additional-platforms.json`, `assets/*.js` | **Generated.** Do not edit by hand. |

## Running locally

```bash
lintrunner init            # once; installs the generators' dependencies (markdown, pygments)
lintrunner --take QUICK_START -a
```

The linter runs the same steps as below in a scratch copy of this directory and
writes back the files that changed.

```bash
cd tools/quick_start
# one matrix file per OS and channel, as the lint writes them
for spec in "linux nightly" "windows nightly" "macos-arm64 nightly" \
            "linux release" "windows release" "macos-arm64 release"; do
  set -- $spec
  PACKAGE_TYPE=all OS=$1 CHANNEL=$2 GETTING_STARTED=true BUILD_PYTHON_ONLY=disable \
  WITH_XPU=disable \
    python3 ../scripts/generate_binary_build_matrix.py > "${1/-arm64/}_$2_matrix.json"
done
python3 scripts/gen_quick_start_module.py --autogenerate > assets/quick-start-module.js
rm *_matrix.json

pip install markdown pygments
python3 scripts/gen_additional_platforms.py
```

`additional-platforms.json` records `generated_at` and `generator_commit`. The lint
ignores those two fields, so they only change when the rest of the file does.
