# MODULE: Git Clone
# Handles git repo cloning with cache support

REPO_DIR=""

if [[ -n "$GIT_REPO" ]]; then
    # Check if REPO_CACHE is set (EFS/daemonset provided cache)
    if [[ -n "$REPO_CACHE" && -d "$REPO_CACHE/.git" ]]; then
        echo "[Runner] Using repo cache from $REPO_CACHE"
        cp -r "$REPO_CACHE" repo
        cd repo
        REPO_DIR="$(pwd)"
        export REPO_DIR
    else
{{git_clone_method}}
    fi

    echo "[Runner] REPO_DIR=$REPO_DIR"
else
    echo "[Runner] No git repo specified, skipping clone"
fi
