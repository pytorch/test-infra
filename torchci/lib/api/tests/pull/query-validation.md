# Pull request head: live SQL validation

Validated on 2026-11-05 against production ClickHouse as `hud_user`,
read-only, with the queries of `query.ts` and the rule of `head.ts`
(`newestHead`): the sample between 19:40 and 19:47 UTC, the pushes back to an
earlier head and the exact statements' timings between 20:30 and 20:50.
GitHub's REST API was the reference for each pull request's head; it is not a
source of the endpoint, which reads HUD's database only, as the other tests
endpoints do. Timings ran with the query cache off.

## Why the record alone is not enough

`default.pull_request` is a `SharedReplacingMergeTree` ordered by
`(number, dynamoKey)` with no version column: a merge keeps the row inserted
last. A row written just after a push sometimes still names the head before
it, and when it lands after the push's own row, the record names the old head
until the pull request's next event. `materialized_views.pr_by_sha`, filled by
a materialized view with the head of every row inserted into `pull_request`,
keeps the replaced heads.

The sample was the 1,500 most recently updated pytorch/pytorch pull requests
(`state=all`, sorted by update, updated from 2026-11-03 05:37 to 2026-11-05
19:41 UTC): 735 from branches in the repository, 765 from forks, 1,040 open,
460 closed. Each source's head against GitHub's:

| Source                                                                 | Matched GitHub |
| ---------------------------------------------------------------------- | -------------: |
| Latest record, `ORDER BY updated_at DESC LIMIT 1` (`FINAL` agreed)     |    1,496/1,500 |
| Newest `pull_request` run on the head repository and branch            |    1,483/1,500 |
| Newest push to the branch by head commit time (in-repository branches) |        636/735 |
| The endpoint: record, corrected by the runs of the recorded heads      |    1,500/1,500 |

The four records behind were open pull requests, two from forks: 203277 three
minutes behind its newest head's first run, 203433 23 minutes, 203396 54
minutes, 203180 a day (that head first ran 2026-11-04 19:26). `pr_by_sha` held
the newer head for all four, and for 202963's `31e73b6`, the case that
prompted the commit summary's head lookup on 2026-11-02. The newest run alone
missed 17, 15 from forks and 2 from branches in the repository: in every one
the record's head had no `pull_request` run, and six of the pull requests had
none at all, so the rule keeps the record. GitHub runs no `pull_request`
workflow while a pull request has a merge conflict; four of the 17 checked on
2026-11-05, 198718, 192945, 201655 and the in-repository 193636, were
conflicting. A push waiting for a maintainer's approval does run: its runs
are recorded as `action_required` (1,933 `pull_request` runs on 466 heads in
the 3 days to 2026-11-05 20:49 UTC, none without its head repository and
branch), so it counts. The push table orders by the head commit's timestamp,
which is not push order, and has no pushes for forks.

The end-to-end run against a second GitHub fetch at 19:46:46 used the record
read of `query.ts`, the heads' read with an `ORDER BY newest_run_id` added,
which changes neither its rows nor the choice, and a copy of `newestHead`'s
rule: the endpoint's head matched GitHub's for all 1,500, the record alone
being wrong for four open pull requests.

## Pushes back to an earlier head

The rule goes by the newest run, not the newest head, so a push back to an
earlier head, which runs again, counts as the push it is. In the 60 days to
2026-11-05, queried at about 20:30 UTC, 32 head branches had an older head
run a `pull_request` workflow after a newer head's first run. On 23 the head
that ran last was the newest anyway. On the other 9 the earlier head ran
again, 2 minutes to 2 and a half days after the newer one first ran, and was
GitHub's head when checked: 201141, 202771, 202142, 197591, 194060, 197146,
196593, 196549 and 196359, every one answered right by the endpoint.

One case is answered wrong by construction. A pull request with a merge
conflict pushed back to an earlier head that ran gets no new run, so the rule
answers the later head, where the record has it right. None of the 9 was such
a case.

## The heads' runs read

The baseline reads every `pull_request` run in the repository for the heads
`pr_by_sha` names for the number: the statement of `query.ts` with its id
lookup through `materialized_views.workflow_run_by_head_sha` replaced by a
filter on every run's `head_sha`. Both statements were generated from the
builder in `query.ts`, and their rows compared as sets, since the read has no
`ORDER BY`. Six fixed pull requests: 203277 and 203180, records behind
(in-repository, fork); 198718, a fork whose recorded head never ran; 183755,
closed, its head from May; 193636, idle since September; 195835, a head
absent from the view. Three alternating rounds, each round reversing the
pair's order, run twice, the second time under heavier load on the service:

| Read                  | Server ms, first / second set | Rows read         | Bytes read |
| --------------------- | ----------------------------- | ----------------- | ---------- |
| Record                | 14–21                         | 1,266–3,045       | 0.1–0.5 MB |
| Heads' runs, by id    | 16–164 / 42–610               | 2.03–2.32 million | 19–36 MB   |
| Heads' runs, baseline | 159–778 / 203–3,311           | 15.4 million      | 762–766 MB |

All 36 pairs returned the same rows: 30 nonempty, and 195835's six empty on
both sides, its pull request having no run. In the second set, whose every
execution was recorded, the read by id was the faster in all 18 pairs. The
record read was timed in an earlier round of the same six, with the
builder's statement. The end-to-end run also compared 120 of its 1,500 pull
requests with the baseline row by row, all identical. `EXPLAIN indexes = 1`
shows the read by id keeping 19 of 15,066 `workflow_run` granules for
203277; nearly all of its rows are the scan of `pr_by_sha` for the number,
about 2 million rows, which is ordered by `head_sha` and cannot be pruned by
number. Its cost does not grow with a pull request's age.

## Rejected

- Scanning `workflow_run` by id from the recorded head's first run for newer
  runs on the branch: 6 of 15,065 granules for an active pull request, but
  2.8 million rows and 1.7 s for 183755, whose head first ran in May, and the
  whole table for a head with no run unless the bound is `minOrNull`. The
  recorded heads' runs give the same answers on the sample at a constant
  cost, and need no rule for closed pull requests: the candidates are the
  pull request's own heads, so a fork branch another pull request reused
  later adds nothing.
- The newest run alone, and the push table: see above.

To repeat, fetch heads with `gh api
'repos/pytorch/pytorch/pulls?state=all&sort=updated&direction=desc&per_page=100&page=N'`,
then run `buildPullRequestRecordQuery` and `buildPullRequestHeadRunsQuery`
for each number through the read-only client and compare `newestHead` with
GitHub's `head.sha` straight away, since active pull requests move by the
minute.
