# s3_management

This directory houses scripts to maintain the s3 HTML indices for https://download.pytorch.org/whl

## Creating a new target and checking its dependencies

Users install with `pip install --index-url https://download.pytorch.org/whl/<prefix>/<target>`, so
every dependency of `torch` has to be reachable through that one index.

1. **List the target's dependencies.** `update_dependencies.py --create-target` only creates the
   packages in `PACKAGES_PER_PROJECT` that have no `target` or the matching one. Packages keyed to a
   target (the `nvidia-*`, `cuda-*` and `cupti-python` entries for `cuXXX`, the `rocm-sdk-*` entries
   for `rocmX.Y`) have to list the new target first, or the target is created without them.
2. **Create the target**, as a dry run first. Either run the *Update S3 HTML dependencies* workflow
   with `mode: create-target`, `target: cu134` and `prefix: whl/test`, or locally:

   ```
   python3 s3_management/update_dependencies.py --create-target --target cu134 --prefix whl/test --dry-run
   ```

   `--init-from <existing target>` copies the package indexes of an existing target instead.
3. **Check the dependencies before uploading wheels.** Resolve each built wheel against only the
   new index, with the local wheel supplied through `--find-links` (needs [`uv`](https://docs.astral.sh/uv/);
   nothing is installed):

   ```
   python3 s3_management/validate_target_dependencies.py \
       --prefix whl/test --target cu134 --wheel-dir ./wheelhouse
   ```

   It uses the wheel's real `Requires-Dist`, for the Python version and platform in the wheel's
   tags, and exits non-zero if anything is unresolvable (or if a wheel had to be skipped). Put
   `torch` and the wheels that pin it, such as `torchvision`, in the same directory.

   Notes:
   - ROCm wheels depend on the `rocm` meta package, which the index only has as an sdist. Pass
     `--allow-sdist` to resolve it as pip would. That makes uv run the package's build backend, so
     it is off by default.
   - Pre-releases are allowed (`--prerelease allow`), as pip does when no final release satisfies a
     specifier (for example `rocm==10.0.*` when only 10.0.0rc builds exist). uv's own default
     rejects that.
   - Free-threaded wheels (`cp313t`) are skipped, because uv cannot resolve for that ABI.

## Checking that prod matches test

After syncing a target into prod, compare its dependency packages with the test channel's:

```
python3 s3_management/compare_targets.py --source whl/test/cu134 --dest whl/cu134
```

Only the packages `update_dependencies.py` creates for the target are compared (the test channel
also hosts vllm and its dependencies, which prod does not). It exits non-zero if the destination is
missing a package page or any file the source lists.
