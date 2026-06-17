-- Latest PR state (open/closed) + draft flag for a single PR, used to gate AI
-- advisor auto-dispatch (skip closed/merged or draft PRs). Reads the
-- default.pull_request mirror instead of the GitHub API. Filters on `number`
-- (the table's primary/sorting key) for an indexed lookup; html_url pins the
-- repo since PR numbers are not unique across repos.
SELECT
    state,
    draft
FROM default.pull_request FINAL
WHERE
    number = {prNumber: Int64}
    AND html_url = {htmlUrl: String}
