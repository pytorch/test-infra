#!/usr/bin/env bash

set -e

checks=$(ls *.diff)
found_checks=$(/bin/clang-tidy --list-checks)
for check in $checks; do
  name=${check%-check.*}
  grep "$name" <<< "$found_checks"
done

echo "verified!"
