select
    w.name,
    w.conclusion,
    w.completed_at,
    w.html_url,
    w.head_sha,
    p.number,
from
    commons.workflow_job w inner join commons.pull_request p on w.head_sha = p.head.sha   
where
	PARSE_TIMESTAMP_ISO8601(w.completed_at) > (CURRENT_TIMESTAMP() - MINUTES(:numMinutes))
group by
    name,
    conclusion,
    completed_at,
    html_url,
    head_sha,
    number