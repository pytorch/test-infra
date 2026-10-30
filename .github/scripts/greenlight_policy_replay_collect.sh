#!/usr/bin/env bash
# Run from tools/ by the collect job of .github/workflows/greenlight-policy-replay.yml, whose step env it reads.
set -euo pipefail
[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ && "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid policy commits: '$BASE_SHA', '$HEAD_SHA'" >&2; exit 1; }
collected="$RUNNER_TEMP/greenlight-collected"
mkdir -p "$collected"
# Any non-zero exit fails the job, including 3: a degraded export would bias the frame the replays are sampled from.
PYTHONPATH=. python3 -m torchci.greenlight_decisions --output "$collected/decisions.csv"
# Both arms record into one directory, so a call the change arm repeats is answered from
# the base arm's record instead of reaching GitHub again.
PYTHONPATH=. python3 -m torchci.greenlight_replay.collect \
  --input "$collected/decisions.csv" \
  --policy-ref "$BASE_SHA" \
  --sample-frac "$GREENLIGHT_REPLAY_SAMPLE_FRACTION" \
  --sample-n "$GREENLIGHT_REPLAY_SAMPLE_CAP" \
  --seed "$GREENLIGHT_REPLAY_SEED" \
  --parallelism "$GREENLIGHT_REPLAY_PARALLELISM" \
  --output "$collected/sample.csv" \
  --answers "$collected/github"
PYTHONPATH=. python3 -m torchci.greenlight_replay.collect \
  --input "$collected/sample.csv" \
  --presampled \
  --policy-ref "$HEAD_SHA" \
  --parallelism "$GREENLIGHT_REPLAY_PARALLELISM" \
  --answers "$collected/github"
