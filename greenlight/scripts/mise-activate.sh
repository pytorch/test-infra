#!/usr/bin/env bash
# Activate mise-managed tools for shebang recipes, which bypass the justfile `set shell` directive.
if command -v mise >/dev/null 2>&1; then
  eval "$(mise env -s bash)"
fi
