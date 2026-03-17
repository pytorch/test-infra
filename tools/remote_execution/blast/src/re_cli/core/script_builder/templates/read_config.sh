# MODULE: Git Read Config
# GIT_REPO and GIT_COMMIT are already set as env vars by the CLI

if [[ -n "$GIT_REPO" ]]; then
    echo "[Runner] Git repo: $GIT_REPO"
fi
if [[ -n "$GIT_COMMIT" ]]; then
    echo "[Runner] Git commit: $GIT_COMMIT"
fi

export GIT_REPO
export GIT_COMMIT
