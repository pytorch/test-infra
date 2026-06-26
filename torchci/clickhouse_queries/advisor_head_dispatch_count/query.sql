-- Count of DISTINCT signal_keys ever recorded (any state) for one PR head
-- commit. Used as the cumulative budget basis for the AI advisor per-head
-- dispatch cap (maxDispatchPerPr): it counts every signal already fanned out on
-- this head, including ones that have since stopped failing, so the cap holds
-- across cron passes rather than re-budgeting when the failing set turns over.
-- A bare countDistinct over the ReplacingMergeTree is fine -- duplicate version
-- rows for a signal_key collapse under DISTINCT regardless of FINAL.
SELECT countDistinct(signal_key) AS n
FROM misc.ai_advisor_dispatches
WHERE
    owner = {owner: String}
    AND repo = {repo: String}
    AND head_sha = {headSha: String}
