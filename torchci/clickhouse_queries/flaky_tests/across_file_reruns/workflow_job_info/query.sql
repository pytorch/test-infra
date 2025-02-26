with jobs as (
  select
    name,
    id,
    run_id,
    run_attempt,
    html_url
  from default.workflow_job final
  where
    id in {job_ids: Array(Int64)}
    and name not like '%rerun_disabled_tests%'
)
select
  j.name as name,
  w.name as workflow_name,
  j.id as id,
  w.id as workflow_id,
  w.head_branch as head_branch,
  j.run_attempt as run_attempt,
  j.html_url as html_url
from
  default.workflow_run w final join jobs j on w.id = j.run_id
where
  w.id in (select run_id from jobs)
