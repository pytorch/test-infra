# MODULE: Git Clone (Copy Method)
# Copies cache to workspace instead of using reference

# Git cache configuration
GIT_CACHE="{{cache_path}}"
git config --global --add safe.directory "*" 2>/dev/null || true

if [[ "$GIT_REPO" == *"{{cache_repo_pattern}}"* ]] && [ -d "$GIT_CACHE/.git" ]; then
    CACHE_HEAD=$(git -C "$GIT_CACHE" rev-parse HEAD 2>/dev/null || echo "unknown")
    echo "[Runner] Git cache found (HEAD: ${CACHE_HEAD:0:8})"

    echo "[Runner] Copying cache to workspace..."
    cp -r "$GIT_CACHE" repo
    cd repo
    git remote set-url origin "$GIT_REPO"
    REPO_DIR="$(pwd)"
    export REPO_DIR
else
    echo "[Runner] Cloning $GIT_REPO (no cache)..."
    git clone "$GIT_REPO" repo
    cd repo
    REPO_DIR="$(pwd)"
    export REPO_DIR
fi
