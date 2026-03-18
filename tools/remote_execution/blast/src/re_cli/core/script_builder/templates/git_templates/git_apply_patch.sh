# MODULE: Apply Git Patch
# Applies patch file after git clone

PATCH_FILE="$ARTIFACTS_DIR/git-changes/changes.patch"

if [[ -f "$PATCH_FILE" ]]; then
    echo "[Runner] Applying patch: $PATCH_FILE"
    git apply "$PATCH_FILE"

    # Configure git user for commit (required in CI environments)
    git config user.email "remote-execution@ciforge.local"
    git config user.name "Remote Execution"

    # Add and commit all changes to avoid "dirty checkout" error
    git add -A
    git commit -m "Applied patch from remote execution" --allow-empty
    echo "[Runner] Patch applied and committed successfully"
fi
