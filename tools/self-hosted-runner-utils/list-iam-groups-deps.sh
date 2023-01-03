#!/bin/bash

TMPFILE1=$(mktemp /tmp/list_iam_groups_deps.1.XXXXXX)
TMPFILE2=$(mktemp /tmp/list_iam_groups_deps.2.XXXXXX)

trap "rm -rf '${TMPFILE2}' '${TMPFILE1}'" EXIT

aws iam list-groups --query 'Groups[*].GroupName' \
  | jq '.[]' \
  | sed 's/"//g' >"${TMPFILE2}"

while read group_name ; do
  aws iam get-group --group-name "${group_name}" --query "Users[*].UserName" \
    | jq '.[]' >"${TMPFILE1}"
  users_count=$(wc -l <"${TMPFILE1}")

  if [[ "${users_count}" -gt 0 ]] ; then
    echo -n "${group_name}: "
    tr '\n' ' ' <"${TMPFILE1}"
    echo ""
  else
    echo "${group_name}: [EMPTY]"
  fi
done <"${TMPFILE2}"
