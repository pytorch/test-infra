#!/usr/bin/env bash

set -xe

checks=$(pushd 11.x-patches > /dev/null; ls *.diff; popd >/dev/null)
found_checks=$(clang-tidy -checks=* --list-checks)
for check in $checks; do
  name=${check%-check.*}
  echo $name
  grep "$name" <<< "$found_checks"
done

echo "verified!"
