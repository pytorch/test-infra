#!/bin/bash
# Sanitize an untrusted pytorch/pytorch checkout before the greenlight reviewer
# (Claude Code) is pointed at it: strip every in-repo AI-assistant instruction
# file so a reviewed PR cannot rewrite the reviewer's own steering, then restore
# ONLY the trusted skills tree taken from pytorch main.
#
# Usage: sanitize-untrusted-checkout.sh <untrusted_dir> <trusted_skills_src_dir>
#
# The forbidden-name set in forbidden_find below MUST stay equal to the files
# Claude Code auto-loads as memory/steering. CLAUDE.md, CLAUDE.local.md and
# .claude/rules are the load-bearing memory vector; AGENTS.md, .cursorrules and
# .github/copilot-instructions.md are defense-in-depth over-coverage. A name that
# starts being auto-loaded but is missing from this set silently fails open, so
# re-verify the set on any claude-code-action / Claude Code CLI bump
# (last verified: CLI 2.1.169 / action v1.0.141).
#
# forbidden_find is the SINGLE source of that set: both the strip pass and the
# verify pass go through it, so the two can never diverge (a divergence would
# leave a name stripped-but-unverified or verified-but-unstripped).
set -euo pipefail

usage() {
  echo "usage: $(basename "$0") <untrusted_dir> <trusted_skills_src_dir>" >&2
  exit 1
}

untrusted_dir="${1:-}"
trusted_skills_src="${2:-}"
[[ -n "$untrusted_dir" && -n "$trusted_skills_src" ]] || usage

# Refuse a symlinked untrusted_dir instead of following it: find's default -P
# walk does not descend a symlinked start point, so stripping a symlinked arg
# would be a silent no-op AND the verify pass would skip it too — a fail-OPEN.
if [[ -L "$untrusted_dir" ]]; then
  echo "error: untrusted dir '$untrusted_dir' is a symlink; refusing to sanitize" >&2
  exit 1
fi

if [[ ! -d "$untrusted_dir" ]]; then
  echo "error: untrusted dir '$untrusted_dir' is missing or not a directory" >&2
  exit 1
fi

# Canonicalize once (existence already checked): folds trailing/double slashes,
# '..' and any parent-component symlinks into one absolute form so the strip,
# restore and verify passes all compare against the same paths. Resolving the
# arg's own path does NOT make find's -P walk follow symlinks INSIDE the tree; a
# raw trailing slash would otherwise break the exact-path allowlisting of the
# restored .claude dir in the verify pass.
untrusted_dir="$(realpath "$untrusted_dir")"

# No -L / -follow anywhere: find must never traverse a symlink, so an attacker
# symlink planted under the untrusted checkout cannot redirect a match (or a
# deletion) outside the arg dir.
forbidden_find() {
  local root="$1"
  shift
  # -depth is load-bearing on GNU findutils: when -exec rm -rf deletes a matched
  # directory (e.g. .claude), processing a directory's contents BEFORE the
  # directory itself keeps find from descending into a path rm already removed,
  # which would otherwise error and abort the walk.
  find "$root" -depth \
    \( \
    -name 'CLAUDE.md' -o \
    -name 'CLAUDE.local.md' -o \
    -name 'AGENTS.md' -o \
    -name '.claude' -o \
    -name '.cursorrules' -o \
    -path '*/.github/copilot-instructions.md' \
    \) "$@"
}

# Strip pass: remove every forbidden name tree-wide, uniformly for file, dir and
# symlink (rm -rf handles all three; rm never follows a symlink argument).
forbidden_find "$untrusted_dir" -exec rm -rf {} +

# Restore pass: bring back ONLY the trusted skills tree. Skills are opt-in tools,
# not auto-loaded steering, so restoring them cannot re-inject verdict-drifting
# instructions. No-op when the source has no skills tree.
skills_src="$trusted_skills_src/.claude/skills"
restored_skills_dir="$untrusted_dir/.claude/skills"
restored_skills=false
if [[ -d "$skills_src" ]]; then
  mkdir -p "$untrusted_dir/.claude"
  cp -a "$skills_src" "$restored_skills_dir"
  # Defense in depth even though main is trusted: run the SAME forbidden set over
  # the restored tree, so a CLAUDE.md/.claude that ever lands in main's skills
  # cannot reintroduce a loadable memory file under the checkout; then drop any
  # symlink so nothing in the tree can later be followed out of it.
  forbidden_find "$restored_skills_dir" -exec rm -rf {} +
  find "$restored_skills_dir" -type l -delete
  # Only claim a restore if skills actually survived the scrub.
  if [[ -n "$(find "$restored_skills_dir" -mindepth 1 -print -quit)" ]]; then
    restored_skills=true
  fi
fi

# Verify pass (fail-closed, SAME forbidden set): nothing forbidden may survive
# anywhere under the checkout — including inside the restored skills tree — and
# the only .claude permitted is the restored skills-only tree.
[[ -d "$untrusted_dir" ]] || {
  echo "error: '$untrusted_dir' vanished during sanitize" >&2
  exit 1
}

violations=()

# Only the restored top-level .claude directory node itself is a sanctioned
# survivor of the forbidden set (it matches -name '.claude'); its shape is
# checked separately below. Any deeper match — e.g. a CLAUDE.md or nested .claude
# that slipped into the restored skills tree — is a violation, so the restored-
# tree scrub above is enforced here, not assumed.
while IFS= read -r -d '' path; do
  case "$path" in
    "$untrusted_dir/.claude") continue ;;
    *) violations+=("$path") ;;
  esac
done < <(forbidden_find "$untrusted_dir" -print0)

# The restored .claude must contain ONLY skills/ (no CLAUDE.md, rules/,
# settings*.json, commands/, agents/, hooks/, .mcp.json, ...).
if [[ -d "$untrusted_dir/.claude" ]]; then
  while IFS= read -r -d '' child; do
    [[ "${child##*/}" == "skills" ]] || violations+=("$child")
  done < <(find "$untrusted_dir/.claude" -mindepth 1 -maxdepth 1 -print0)
fi

if [[ ${#violations[@]} -gt 0 ]]; then
  echo "error: sanitize verification failed; forbidden paths survived:" >&2
  printf '  %s\n' "${violations[@]}" >&2
  exit 1
fi

if [[ "$restored_skills" == true ]]; then
  echo "sanitize ok: stripped AI-assistant instruction files from '$untrusted_dir'; trusted skills restored."
else
  echo "sanitize ok: stripped AI-assistant instruction files from '$untrusted_dir'; no skills to restore."
fi
