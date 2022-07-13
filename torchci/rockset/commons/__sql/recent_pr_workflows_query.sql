select
	w.name as job_name,
    w.conclusion,
    w.completed_at,
    w.html_url,
    w.head_sha,
    p.number as pr_number,
    p.user.login as owner_login,
from
	commons.workflow_job w inner join commons.pull_request p on w.head_sha = p.head.sha
where
	w.head_sha in (
      select
          w.head_sha
      from
      	commons.workflow_job w
      where 
      	PARSE_TIMESTAMP_ISO8601(w.completed_at) > (CURRENT_TIMESTAMP() - MINUTES(:numMinutes))
    )
    and w.head_sha = p.head.sha 
    and p.base.repo.full_name = 'pytorch/pytorch'
    
group by
	job_name,
    conclusion,
    completed_at,
    html_url,
    head_sha,
    pr_number,
    owner_login