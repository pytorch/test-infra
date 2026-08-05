#!/bin/bash
# PreToolUse hook for Write/Edit: the greenlight verdict file is the ONLY path
# Claude may write; block everything else.
#
# Hook contract: exit 0 defers to the normal permission flow (allow here),
# exit 2 blocks. Only exit 2 blocks a PreToolUse call -- a non-2 exit (incl. 1)
# is a non-blocking error and the write proceeds. So every deny path exits 2
# explicitly and `set -e` is avoided: a stray failure must never silently allow.

VERDICT_FILE="/tmp/greenlight-verdict.json"

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

# No target path: fail closed rather than allow an unclassified write.
if [[ -z "$file_path" ]]; then
  echo "Write blocked: no file_path in tool input." >&2
  exit 2
fi

# The single fixed target is compared as a literal string, not canonicalized: on
# macOS /tmp is itself a symlink to /private/tmp, so resolving it would break the
# match against the absolute path Claude actually passes.
if [[ "$file_path" == "$VERDICT_FILE" ]]; then
  # Defense in depth: refuse a pre-existing symlink at the target, which could
  # redirect the write outside /tmp. A regular file or a not-yet-created path is
  # fine (-L is false for both).
  if [[ -L "$file_path" ]]; then
    echo "Write blocked: $VERDICT_FILE is a symlink." >&2
    exit 2
  fi
  exit 0
fi

echo "Write is restricted to $VERDICT_FILE. Got: $file_path" >&2
exit 2
