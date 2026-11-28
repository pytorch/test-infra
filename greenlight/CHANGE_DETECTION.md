# Change detection (`change_source` in a repo's config)

How a listing scan learns which PRs changed. `--pr` lists nothing, and a scan whose memory holds no
usable view lists as a `github` repo until its next full tick (below).

A repo picks its source with two optional keys of its own `.github/greenlight/config.yml`
([REPOS.md](REPOS.md)):

```yaml
change_source: clickhouse   # github | clickhouse; optional, default github
full_tick_minutes: 240      # 60 to 1440; optional, only with clickhouse, default 240
```

`clickhouse` is valid only for the repos in `constants.CLICKHOUSE_CHANGE_SOURCE_REPOS` (today
`pytorch/pytorch`): every `clickhouse` repo runs its own marker and freshness queries on HUD's shared
ClickHouse cluster each tick, so a pytorch/test-infra PR adds a repo there, as one does for `drci`.
`pytorch/pytorch` reads both keys from its file like `mode`; a bad value there is logged and ignored,
keeping `github` and 240, and `greenlight check-config` reports it. On any other repo a bad value
makes the file invalid.

**`github`** polls GitHub: a full tick every 15 minutes lists every open PR and fingerprints with no
reuse, and the fast ticks between walk the PRs updated inside the review window plus the open
`Reverted` PRs (README.md, "Which open PRs a listing scan reads").

**`clickhouse`** is for a repo HUD covers: the pytorchbot App is installed on it, so its webhooks reach
HUD ClickHouse's `default.pull_request`, `pull_request_review`, `pull_request_review_comment` and
`issue_comment`. The scan keeps a view of the repo's open PRs (`pr_view.py`), filled from GitHub
listings only and kept in the repo's stored scan memory ([SCAN.md](SCAN.md), "The state store"). The
view holds the PRs whose author is in the tick's evaluation cohort, drafts included, which is what a
`github` repo lists, and the cohort's digest. Each tick (`change_listing.py`) is one of:

- **full**, the reconciliation sweep: `full_tick_minutes` after the start of the last full tick that
  completed, or 15 minutes (`FULL_TICK_INTERVAL`) while the reading is stale. It lists every open PR,
  rebuilds the view with the tick's cohort and fingerprints with no reuse.
- **wide**: 15 minutes after the last full or wide tick that completed. Its candidates are every PR of
  the view, the set a full tick lists, so the revert guard reaches every open PR with a recorded
  `REVERTED` row and the recency filter keeps every idle PR whose review is unfinished, as often as
  on a `github` repo.
- **event**: otherwise. Its candidates are the view's PRs inside the review window.
- **no usable view**: the memory holds none (a cold start, a memory stored by an older release, a view
  too big to store), or the cohort changed since the view was built (a `merge_rules.yaml` edit). The
  repo then ticks as a `github` repo: its full tick comes 15 minutes after the last one started, or at
  once when none completed, and rebuilds the view; the fast ticks before it read no ClickHouse.

A wide or event tick first reads each view PR's marker from ClickHouse (`change_feed.py`): its newest
`pull_request` event, its review and review-comment event counts, and its issue-comment count and
newest comment time, bot authors left out (`pr_hash.is_bot`'s rule). Then it walks GitHub's PRs,
open and closed, updated since the previous listing less 10 minutes (`LISTING_OVERLAP`), usually one
page, and updates the view from them: pushes, comments, base edits, labels, draft changes, closes,
merges, reopens and new PRs by cohort authors all come from GitHub, never from HUD; a PR the walk
shows closed, or by an author no longer in the cohort (a login rename), leaves the view. The open
`Reverted` PRs are listed from GitHub every tick. A PR whose marker shows a non-bot comment or a
`pull_request` event newer than the view's `updated_at` counts as updated then when the review window
is applied, so a PR whose place in GitHub's updated order lags still enters it.

When the marker's `pull_request` event is newer than the view's record, the view missed that event
(a draft marked ready, a label, a base change, a close): while the reading is fresh, the tick reads
that PR from GitHub on its own, up to 20 a tick, the PRs never tried at that event first, then the
one tried longest ago, so a PR whose read keeps failing goes behind the others. The event counts as
seen once a read returns a record at least as new as it; a read that lags is tried again on later
ticks, up to five times at that event, then given up with a warning. A rate limit stops the tick's
GitHub work, as on any listing.

The marker is part of the fingerprint cache key, so what `updated_at` cannot show (a review
dismissal, a review edit, an inline comment edit or delete, a quick second review) invalidates the
kept result at once, not at the next full tick. A result is kept only once the scan first saw its
marker at least two minutes earlier (`FINGERPRINT_QUIET`), so a GitHub read lagging an event
ClickHouse already has is never kept; the tick after a full listing therefore fetches the window's
eligible PRs once more. A PR with no marker reading (the reads fail, or the walk just added it) is
kept on the `updated_at` rule alone, as on a `github` repo. A kept result of a PR whose latest
recorded row is `LAND` is not reused once it is 15 minutes old, or when it was stored after the
reader's clock, whatever ClickHouse says: pytorch's land gate checks only the head SHA, so an approval
keeps the bound a `github` repo's full tick gives it.

**Freshness.** While the reading is stale the repo's full tick comes every 15 minutes, as on a
`github` repo. It is stale when ClickHouse's newest event over the four tables is more than 10 minutes
old (`STALE_AFTER`), one table's newest is older than that table's own threshold
(`TABLE_STALE_AFTER`, each above its longest gap measured over a week: `pull_request` 45 minutes,
`issue_comment` 30, reviews 75, review comments 120), the read fails, or ClickHouse has no row for any
of the view's PRs (a repo HUD does not cover), or the repo's own newest issue comment is more than 75
minutes old (`REPO_STALE_AFTER`, above `pytorch/pytorch`'s longest gap between issue-comment events
over two weeks, 64 minutes), so a pipeline that stops delivering one repo's events while the others'
keep the tables fresh is caught too; a repo quieter than that reads stale and polls. Rows dated more
than 5 minutes ahead are ignored. Each
read runs under `max_execution_time` (10 s) on a client with 15 s socket timeouts, and in a thread
the tick abandons after `CHANGE_FEED_DEADLINE_SECONDS` (20 s), since socket timeouts do not bound
connection set-up, retries or a response that keeps trickling: a read past it is a failed reading,
and the tick goes on.

**What waits for the sweep**, at most `full_tick_minutes`: an issue comment deletion that does not
bump `updated_at`; an approver's login rename; a non-bumping event whose webhook HUD lost, or that
one stalled stream holds below its table's threshold; a review or push on a PR whose place in
GitHub's updated order lags more than `LISTING_OVERLAP`, which the recent listing therefore misses.
None of these keeps an earlier LAND usable for longer than 15 minutes once its PR is a candidate (the
LAND bound above). A base change, an author change or a draft flag the walk misses while the marker
reading is stale or its `pull_request` webhook was lost reaches the ineligible revoke at the next wide
tick on a PR whose latest recorded row is `LAND`: each wide tick reads those PRs alone from GitHub
first. On any other PR it waits for the sweep, or the 15-minute full tick while stale.

Each tick logs one line per `clickhouse` repo: its kind, its source (`ClickHouse`, `GitHub, stale:`
and why, or `GitHub, no usable view`), the PRs it listed, the PRs it read on their own, its
candidates, and the PRs whose marker changed; a wide tick also logs how many `LAND` PRs it read again.

**Cost.** Per tick: the recent listing (usually 1 request), the `Reverted` listing (1) and the
fingerprints of changed PRs; every 15 minutes, the revert guard over the PRs with a recorded
`REVERTED` row, a read of each PR whose latest row is `LAND` and the LAND revalidation. ClickHouse,
measured on `pytorch/pytorch` (2026-11-24): the marker query over the view's about 650 PRs takes about
0.3 s of server time and reads about 100 MB, the freshness query about 2 s, as it scans each table's
event-time column; a full tick reads the markers a second time after its listing. The review
tables cannot be read by PR number without reading their whole `pull_request` Tuple, so their narrow
columns are read in full; a projection or materialized view keyed by repo and PR number on the HUD
cluster would bound every read. Each `clickhouse` repo runs a marker query and a freshness query of
its own (the freshness answer is the same for every repo), which is why the allowlist holds the
source to `pytorch/pytorch` until one combined marker query and one shared freshness reading per
tick exist.

**Access.** The ClickHouse user the scan Lambda runs with must read the columns `change_feed.py`
names in the four webhook tables, and set `max_execution_time` per query: keep the profile at
`readonly=1` and give `max_execution_time` a settings constraint of kind `changeable_in_readonly`
with a maximum of 10, rather than `readonly=2`, which lets every setting change. A manual scan
(`greenlight-review.yml`, with the shared HUD user) reads them too on its full listing. Without the
grant every reading fails, logged as an error, and the repo behaves as stale: today's 15-minute full
ticks, with kept results reused as on a `github` repo.

**Turning it on, and back off.** `BUILTIN_PYTORCH` keeps `github`, so a repo with no file, or one
never read, polls. The config cache keeps a `clickhouse` value in force when the file later turns
unreadable (it serves the last file read) or is removed (`pytorch/pytorch` is then safety-only under
its last valid settings): the way back to polling is `change_source: github`, or deleting the line.
A file adds either key only once the pinned scan release knows it: an older release reads it as an
unknown key, which makes any repo but `pytorch/pytorch` safety-only, and a `check-config` CI step
must run a release that knows it.

**Before and after.** A config PR in `pytorch/pytorch` setting `change_source: github` for a measured
window, then back to `clickhouse`, compares the two on one release in the tick's per-repo request log
line and the tick line above. Leave out the first ticks after each switch: a switch back lists as a
`github` repo until its next full tick rebuilds the view, and the tick after that fetches the window
again.
