-- Latest AI advisor verdict for one (repo, suspect commit, signal_key). Backs
-- the Dr.CI advisor badge endpoint. Filters the verdict table's ORDER BY prefix
-- (repo, suspect_commit, signal_key, timestamp), so it reads only the relevant
-- granules.
SELECT
    verdict,
    confidence,
    run_id
FROM
    misc.autorevert_advisor_verdicts
WHERE
    repo = {repo: String}
    AND suspect_commit = {sha: String}
    AND signal_key = {signalKey: String}
ORDER BY
    timestamp DESC
LIMIT 1
