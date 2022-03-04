SELECT
    FORMAT_ISO8601(
        PARSE_TIMESTAMP_ISO8601(all_commits.commit.timestamp),
        'America/Los_Angeles'
    ) as timestamp,
    all_commits.commit.id as sha,
    all_commits.commit.url As url,
    ELEMENT_AT(SPLIT(all_commits.commit.message, chr(10), 2), 1) as message,
    CASt(
        REGEXP_EXTRACT(
            all_commits.commit.message,
            'Pull Request resolved: .*?(\d+)',
            1
        ) as int
    ) as prNum,
    REGEXP_EXTRACT(
        all_commits.commit.message,
        'Differential Revision: (D.*)',
        1
    ) as diffNum,
    push.ref as ref,
    all_commits.index,
FROM
    push,
    UNNEST(push.commits as commit with ORDINALITY as index) as all_commits
WHERE
    push.head_commit is not null
    AND push.ref = :branch
    AND push.repository.owner.name = :owner
    AND push.repository.name = :repo
ORDER BY
    timestamp DESC,
    all_commits.index DESC
LIMIT
    50 OFFSET :page * 50
