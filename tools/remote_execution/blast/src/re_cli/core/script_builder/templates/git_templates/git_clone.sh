# MODULE: Git Clone
# Shallow clone of git repo

if [[ -n "$GIT_REPO" ]]; then
    echo "[Runner] Cloning $GIT_REPO (shallow)..."
    git clone --depth=1 "$GIT_REPO" repo
    cd repo
    REPO_DIR="$(pwd)"
    export REPO_DIR
    echo "[Runner] REPO_DIR=$REPO_DIR"
else
    echo "[Runner] No git repo specified, skipping clone"
fi
