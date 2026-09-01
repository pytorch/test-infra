#!/usr/bin/env bash

# NOTE: You need a valid GITHUB_TOKEN to run this

if [[ ! -f runner_state ]]; then
  python3 check_runners_state_org.py pytorch > runner_state
fi

# NOTE: The correct way of doing this would be to look at each possible SKU and determine how many GPUs are connected but for the sake of a quick
#       turnaround we will assume that each NVIDIA machine only has one gpu attatched

nvidia_gpus=$(grep -e "nvidia" -e "a100" runner_state | sed 's/^[ \t]*//' | cut -d " " -f 1 | cut -d "/" -f 2 | awk '{sum+=$1} END {print sum}')
amd_gpus=$(grep -e "rocm" runner_state | sed 's/^[ \t]*//' | cut -d " " -f 1 | cut -d "/" -f 2 | awk '{sum+=$1} END {print sum}')


echo "NVIDIA GPUs: ${nvidia_gpus}"
echo "AMD GPUs: ${amd_gpus}"
