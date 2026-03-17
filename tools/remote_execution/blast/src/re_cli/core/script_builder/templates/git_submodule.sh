# MODULE: Git Submodule
# Update submodules after checkout with cache support

if [[ -n "$REPO_DIR" ]]; then
    cd "$REPO_DIR"

    # Check if cache has submodules
    if [[ -n "$GIT_CACHE" && -d "$GIT_CACHE/third_party" ]]; then
        echo "[Runner] Copying submodules from cache..."
        COPIED_COUNT=0

        # First, copy .git/modules directory which contains actual submodule git data
        if [ -d "$GIT_CACHE/.git/modules" ]; then
            echo "[Runner]   Copying .git/modules..."
            mkdir -p "$REPO_DIR/.git/modules"
            cp -r "$GIT_CACHE/.git/modules/"* "$REPO_DIR/.git/modules/" 2>/dev/null || true
        fi

        # Copy all third_party subdirs
        for subdir in "$GIT_CACHE"/third_party/*/; do
            subname=$(basename "$subdir")
            target="$REPO_DIR/third_party/$subname"
            if [ -d "$subdir" ]; then
                if [ ! -e "$target/.git" ]; then
                    echo "[Runner]   Copying third_party/$subname"
                    cp -r "$subdir" "$REPO_DIR/third_party/" 2>/dev/null || true
                    COPIED_COUNT=$((COPIED_COUNT + 1))
                fi
            fi
        done

        # Copy android/libs/fbjni if exists
        if [ -d "$GIT_CACHE/android/libs/fbjni" ]; then
            echo "[Runner]   Copying android/libs/fbjni"
            mkdir -p "$REPO_DIR/android/libs"
            cp -r "$GIT_CACHE/android/libs/fbjni" "$REPO_DIR/android/libs/" 2>/dev/null || true
            COPIED_COUNT=$((COPIED_COUNT + 1))
        fi

        echo "[Runner] Copied $COPIED_COUNT submodules from cache"
        echo "[Runner] Syncing submodules..."
        git submodule sync --recursive 2>/dev/null || true
        git submodule update --init --recursive --force 2>&1 || {
            echo "[Runner] Warning: some submodules failed, retrying without force..."
            git submodule update --init --recursive 2>&1 || true
        }

        echo "[Runner] Submodules updated from cache!"
    else
        echo "[Runner] Updating submodules (no cache)..."
{{submodule_commands}}
        echo "[Runner] Submodules updated!"
    fi
fi
