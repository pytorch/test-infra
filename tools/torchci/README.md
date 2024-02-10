This is meant to contain all the random python scripts we make for things like
TD, alerting, revert tracking, etc.

It was originally located in torchci/scripts but moved to here to separate the
python "packaging" from the javascript/typescript.

To run these files without needing to modify `sys.path` in each file, either
1. Run `pip install -e .` from within `tools/torchci`. Run python files as normal, from anywhere.
2. Add to your `PYTHONPATH` env var via `export PYTHONPATH="${PYTHONPATH}:<repo root>/tools"`. Run python files as normal, from anywhere.
3. Run every file as a module from within `tools`, ex `cd tools && python -m torchci.td.td_rockset_analysis`.
