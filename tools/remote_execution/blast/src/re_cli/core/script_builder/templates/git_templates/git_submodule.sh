# MODULE: Git Submodule
# Update submodules after checkout

if [[ -n "$REPO_DIR" ]]; then
    cd "$REPO_DIR"
    echo "[Runner] Updating submodules..."
    git submodule update --init --depth=1 --jobs=8
    echo "[Runner] Submodules updated!"
fi
