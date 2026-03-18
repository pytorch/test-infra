-- These are simple alerts but there are many versions of them with minor variants
-- Putting them all in this one file for simplicity

-- Get max_queue_time_mins - normal alert
select
  max(max_queue_time_mins)
from materialized_views.queued_runners_mv
WHERE TRUE
  AND repo = 'pytorch/pytorch'
  -- exclude machines which we want to set a higher threshold for or different notification logic for
  AND NOT multiSearchAnyCaseInsensitive(machine_type, [
    'rocm',
    'xpu',
    's390x',
    'b200',
    'h100',
    'macos'
  ])



-- Get max_queue_size - normal alert
select
  max(machines_queueing)
from materialized_views.queued_runners_mv
WHERE TRUE
  AND repo = 'pytorch/pytorch'
  -- exclude machines which we want to set a higher threshold for or different notification logic for
  AND NOT multiSearchAnyCaseInsensitive(machine_type, [
    'rocm',
    'xpu',
    's390x',
    'b200',
    'h100',
    'macos'
  ])
