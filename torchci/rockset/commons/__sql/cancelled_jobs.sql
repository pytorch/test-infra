SELECT concat('https://github.com/pytorch/pytorch/actions/runs/', CAST(id as string)) AS url, name, head_sha, head_commit_message, updated_at
FROM commons.workflow_run
where conclusion = 'cancelled' and head_branch = 'master' 
  AND _event_time >= PARSE_DATE_ISO8601(:startTime)
  AND _event_time < PARSE_DATE_ISO8601(:stopTime)
ORDER BY updated_at desc

