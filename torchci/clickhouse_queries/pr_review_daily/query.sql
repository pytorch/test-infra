-- Per day: PRs the automated PR review finished reviewing and how many of
-- them it blocked (changes_requested), next to PRs that maintainers (members,
-- owners and collaborators; bots excluded) reviewed and how many of them they
-- blocked. Drives the review agent's daily production dashboard.
--
-- A PR counts once per day on each side, however many reviews it got that
-- day. Days are UTC. A day with reviews on only one side has zeros on the
-- other.
SELECT
    day,
    sum(agent_prs) AS agent_prs,
    sum(agent_blocked) AS agent_blocked,
    sum(human_prs) AS human_prs,
    sum(human_blocked) AS human_blocked
FROM (
    SELECT
        toDate(timestamp) AS day,
        uniqExact(pr_number) AS agent_prs,
        uniqExactIf(pr_number, verdict = 'changes_requested') AS agent_blocked,
        0 AS human_prs,
        0 AS human_blocked
    FROM misc.pr_review_verdicts
    WHERE
        repo = {repo: String}
        AND phase = 'terminal'
        AND status = 'succeeded'
        AND timestamp >= {startTime: DateTime64(3)}
        AND timestamp < {stopTime: DateTime64(3)}
    GROUP BY day

    UNION ALL

    SELECT
        toDate(review.submitted_at) AS day,
        0 AS agent_prs,
        0 AS agent_blocked,
        uniqExact(pull_request.number) AS human_prs,
        uniqExactIf(pull_request.number, review.state = 'changes_requested')
            AS human_blocked
    FROM default.pull_request_review
    WHERE
        repository.full_name = {repo: String}
        AND action = 'submitted'
        AND review.user.type = 'User'
        -- Bot accounts that are ordinary GitHub users.
        AND review.user.login NOT IN (
            'pytorchgreenlight',
            'pytorchmergebot',
            'pytorchbot',
            'pytorch-bot',
            'facebook-github-bot'
        )
        AND review.author_association IN ('MEMBER', 'OWNER', 'COLLABORATOR')
        AND review.submitted_at >= {startTime: DateTime64(3)}
        AND review.submitted_at < {stopTime: DateTime64(3)}
    GROUP BY day
)
GROUP BY day
ORDER BY day
