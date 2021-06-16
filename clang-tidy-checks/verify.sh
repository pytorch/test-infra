#!/usr/bin/env bash

set -xe

checks=$(ls *.diff)
found_checks=$(clang-tidy -checks=* --list-checks)
for check in $checks; do
  name=${check%-check.*}
  echo $name
  grep "$name" <<< "$found_checks"
done

echo "verified!"
