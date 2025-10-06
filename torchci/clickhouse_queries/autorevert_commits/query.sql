SELECT
  commit_sha,
  groupArray(workflows) as all_workflows,
  groupArray(source_signal_keys) as all_source_signal_keys
FROM misc.autorevert_events_v2
WHERE repo = {repo: String}
  AND action = 'revert'
  AND dry_run = 0
  AND failed = 0
  AND commit_sha IN {shas: Array(String)}
GROUP BY commit_sha
