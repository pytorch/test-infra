# MODULE: Git Checkout
# Checkout specific commit after clone

if [[ -n "$GIT_COMMIT" && -n "$REPO_DIR" ]]; then
    cd "$REPO_DIR"

    echo "[Runner] Fetching commit $GIT_COMMIT..."
    git fetch origin "$GIT_COMMIT" --depth=1 2>/dev/null || git fetch origin "$GIT_COMMIT"

    echo "[Runner] Checking out $GIT_COMMIT..."
    git checkout -f "$GIT_COMMIT"

    echo "[Runner] Checkout complete!"
fi
