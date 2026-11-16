-- Per-bucket CI volume + cost-by-category + merge/slop for pytorch/pytorch (long format for a table).
-- Categories: inside-PR / after-merge / nightly / periodic / benchmark / other.
-- merged PRs come from squash-merge messages on main (pull_request.merged is unreliable here).
with
  k as (
    select DATE_TRUNC({granularity: String}, date) as b,
           uniqExactIf(key, kind='pr') as n_pr,
           uniqExactIf(key, kind='plain') as n_plain,
           uniqExactIf(key, kind='main') as n_main,
           uniqExactIf(key, kind='merged') as n_merged
    from misc.unit_keys
    where date > {startTime: DateTime64(9)} and date < {stopTime: DateTime64(9)}
      and repo in {selectedRepos: Array(String)}
    group by b
  ),
  c as (
    select DATE_TRUNC({granularity: String}, date) as b,
           sum(pr_cost) prc, sum(main_cost) mc, sum(nightly_cost) nc,
           sum(periodic_cost) pe, sum(benchmark_cost) be, sum(other_cost) ot, sum(total_cost) tot
    from misc.unit_cost_daily
    where date > {startTime: DateTime64(9)} and date < {stopTime: DateTime64(9)}
      and repo in {selectedRepos: Array(String)}
    group by b
  )
select granularity_bucket, metric, value
from (
    select b as granularity_bucket, '# PRs ran CI' as metric, toFloat64(n_pr) as value from k
    union all select b, '# PRs merged', toFloat64(n_merged) from k
    union all select b, 'merge rate %', round(100 * n_merged / nullIf(n_pr, 0), 0) from k
    union all select b, 'commits / PR', round(n_plain / nullIf(n_pr, 0), 2) from k
    union all select c.b, 'inside-PR $', round(prc) from c
    union all select c.b, 'after-merge $', round(mc) from c
    union all select c.b, 'nightly $', round(nc) from c
    union all select c.b, 'periodic $', round(pe) from c
    union all select c.b, 'benchmark $', round(be) from c
    union all select c.b, 'other $', round(ot) from c
    union all select c.b, 'TOTAL $', round(tot) from c
    union all select k.b, 'unmerged PR $ (est)', round(prc * (1 - n_merged / nullIf(n_pr, 0)))
      from k inner join c on k.b = c.b
)
order by granularity_bucket asc
