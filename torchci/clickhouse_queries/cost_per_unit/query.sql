-- Average CI cost per PR / per plain commit / per main commit, per time bucket.
-- PR/plain-commit share the PR-CI cost pool (different denominators); main uses push-to-main cost.
-- Distinct counts are computed PER BUCKET so avg_cost * count reconciles to the bucket total.
with
  c as (
    select DATE_TRUNC({granularity: String}, date) as b,
           sum(pr_cost) as prc, sum(main_cost) as mc
    from misc.unit_cost_daily
    where date > {startTime: DateTime64(9)} and date < {stopTime: DateTime64(9)}
      and repo in {selectedRepos: Array(String)}
    group by b
  ),
  k as (
    select DATE_TRUNC({granularity: String}, date) as b,
           uniqExactIf(key, kind='pr') as n_pr,
           uniqExactIf(key, kind='plain') as n_plain,
           uniqExactIf(key, kind='main') as n_main
    from misc.unit_keys
    where date > {startTime: DateTime64(9)} and date < {stopTime: DateTime64(9)}
      and repo in {selectedRepos: Array(String)}
    group by b
  )
select granularity_bucket, unit, avg_cost
from (
    select c.b as granularity_bucket, 'per PR' as unit,
           round(prc / nullIf(n_pr, 0), 2) as avg_cost
      from c inner join k on c.b = k.b
    union all
    select c.b, 'per plain commit', round(prc / nullIf(n_plain, 0), 2)
      from c inner join k on c.b = k.b
    union all
    select c.b, 'per main commit', round(mc / nullIf(n_main, 0), 2)
      from c inner join k on c.b = k.b
)
order by granularity_bucket asc
