# MODULE: Git Clone (Reference Method)
# Uses git clone --reference for fast cloning with cache

# Git cache configuration
export GIT_CACHE="{{cache_path}}"
export GIT_CONFIG_SYSTEM="/var/cache/git/.gitconfig"
git config --global --add safe.directory "*" 2>/dev/null || true

if [[ "$GIT_REPO" == *"{{cache_repo_pattern}}"* ]] && [ -d "$GIT_CACHE/.git" ]; then
    CACHE_HEAD=$(git -C "$GIT_CACHE" rev-parse HEAD 2>/dev/null || echo "unknown")
    echo "[Runner] Git cache found (HEAD: ${CACHE_HEAD:0:8})"

    echo "[Runner] Using git clone --reference..."
    git clone --reference "$GIT_CACHE" "$GIT_REPO" repo
    cd repo
    REPO_DIR="$(pwd)"
    export REPO_DIR
else
    echo "[Runner] Cloning $GIT_REPO (no cache)..."
    git clone "$GIT_REPO" repo
    cd repo
    REPO_DIR="$(pwd)"
    export REPO_DIR
fi
