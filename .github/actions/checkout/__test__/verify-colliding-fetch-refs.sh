#!/bin/bash

# Verify .git folder
if [ ! -d "./colliding-fetch-refs/.git" ]; then
  echo "Expected ./colliding-fetch-refs/.git folder to exist"
  exit 1
fi

# Verify the checked out commit is the one that triggered the workflow, i.e. the
# colliding additional fetch ref was dropped rather than fetched over it

ACTUAL_SHA=$(git -C colliding-fetch-refs rev-parse HEAD)

if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "Expected ./colliding-fetch-refs to be checked out at $EXPECTED_SHA, got $ACTUAL_SHA"
  exit 1
fi
