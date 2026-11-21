# Change detection (`change_source` in `repos.yaml`)

How a listing scan learns which PRs changed. `--pr` lists nothing, and a CLI one-shot or a process with
no tick memory yet lists every open PR.

Set per repo in `repos.yaml` ([REPOS.md](REPOS.md)).

**`github`** polls GitHub: a full tick every 15 minutes lists every open PR and fingerprints with no
reuse, and the fast ticks between walk the PRs updated inside the review window plus the open
`Reverted` PRs (README.md, "Which open PRs a listing scan reads").

**`clickhouse`** is for a repo HUD covers: the pytorchbot App is installed on it, so its webhooks reach
HUD ClickHouse's `default.pull_request`, `pull_request_review`, `pull_request_review_comment` and
`issue_comment`. The scan keeps a view of the repo's open PRs (`pr_view.py`), filled from GitHub
listings only, and each tick (`change_listing.py`) is one of three kinds:

- **full**, the reconciliation sweep: when the process has no view yet (a cold start, or a repo just
  switched to `clickhouse`), and again `full_tick_minutes` after the start of the last full tick that
  completed. It lists every open PR, rebuilds the view and fingerprints with no reuse.
- **wide**: 15 minutes (`FULL_TICK_INTERVAL`) after the last full or wide tick that completed. Its
  candidates are every open cohort PR of the view, the set a full tick lists, so the revert guard
  reaches every open PR with a recorded `REVERTED` row and the recency filter keeps every idle PR
  whose review is unfinished, as often as on a `github` repo.
- **event**: otherwise. Its candidates are the view's cohort PRs inside the review window.

A wide or event tick first reads each view PR's marker from ClickHouse (`change_feed.py`): its newest
`pull_request` event, its review and review-comment event counts, and its issue-comment count and
newest comment time, bot authors left out (`pr_hash.is_bot`'s rule). Then it walks GitHub's PRs,
open and closed, updated since the previous listing less 10 minutes (`LISTING_OVERLAP`), usually one
page, and updates the view from them: pushes, comments, base edits, labels, draft changes, closes,
merges, reopens and new PRs all come from GitHub, never from HUD. The open `Reverted` PRs are listed
from GitHub every tick. A PR whose marker shows a non-bot comment or a `pull_request` event newer
than the view's `updated_at` counts as updated then when the review window is applied, so a PR whose
place in GitHub's updated order lags still enters it. When the marker's `pull_request` event is newer
than the view's record, the view missed that event (a draft marked ready, a label, a base change, a
close): the tick reads that PR from GitHub on its own, up to 20 a tick, while the reading is fresh,
and not again until its marker shows a newer `pull_request` event (a failed read is retried; a rate
limit stops the tick's GitHub work, as on any listing).

The marker is part of the fingerprint cache key, so what `updated_at` cannot show (a review
dismissal, a review edit, an inline comment edit or delete, a quick second review) invalidates the
kept result at once, not at the next full tick. A result is kept only once this process first saw its
marker at least two minutes earlier (`FINGERPRINT_QUIET`), so a GitHub read lagging an event
ClickHouse already has is never kept; a cold start therefore fetches the window's eligible PRs once
more on its second tick. A PR with no marker reading (the reads fail, or the walk just added it) is
kept on the `updated_at` rule alone, as on a `github` repo. A kept result of a PR whose latest recorded row is `LAND` is not reused once
it is 15 minutes old, whatever ClickHouse says: pytorch's land gate checks only the head SHA, so an
approval keeps the bound a `github` repo's full tick gives it.

**Freshness.** While the reading is stale the repo's full tick comes every 15 minutes, as on a
`github` repo. It is stale when ClickHouse's newest event over the four tables is more than 10 minutes
old (`STALE_AFTER`), one table's newest is older than that table's own threshold
(`TABLE_STALE_AFTER`, each above its longest gap measured over a week: `pull_request` 45 minutes,
`issue_comment` 30, reviews 75, review comments 120), the read fails or passes 10 s, or ClickHouse has
no row for any of the repo's open PRs (a repo HUD does not cover). Rows dated more than 5 minutes
ahead are ignored.

**What waits for the sweep**, at most `full_tick_minutes`: an issue comment deletion that does not
bump `updated_at`; an approver's login rename; a non-bumping event whose webhook HUD lost, or that
one stalled stream holds below its table's threshold; a review or push on a PR whose place in
GitHub's updated order lags more than `LISTING_OVERLAP`, which the recent listing therefore misses.
None of these keeps an earlier LAND usable for longer than 15 minutes once its PR is a candidate (the
LAND bound above), but a base change or a draft flag the walk misses while the marker reading is
stale or its `pull_request` webhook was lost reaches the ineligible revoke only at the sweep, or at
the 15-minute full tick while stale.

Each tick logs one line per `clickhouse` repo: its kind, its source (`ClickHouse`, or `GitHub, stale:`
and why), the PRs it listed, the PRs it read on their own, its candidates, and the PRs whose marker
changed.

**Cost.** Per tick: the recent listing (usually 1 request), the `Reverted` listing (1) and the
fingerprints of changed PRs; every 15 minutes, the revert guard over the PRs with a recorded
`REVERTED` row and the LAND revalidation. ClickHouse: about 1 s of server time per repo per tick. The
review tables cannot be read by PR number without reading their whole `pull_request` Tuple, so their
narrow columns are read in full; a projection or materialized view keyed by repo and PR number on the
HUD cluster would bound every read. Each `clickhouse` repo adds a marker query and a freshness query
of its own (the freshness answer is the same for every repo); one combined marker query and one
freshness reading per tick are due before several repos use `clickhouse`.

**Access.** The scan's ClickHouse user must read the four webhook tables (only the columns
`change_feed.py` names) and be allowed to set `max_execution_time` (a `readonly=1` profile refuses
it; `readonly=2` allows it). Without that every reading fails, logged as an error, and the repo
behaves as stale: today's 15-minute full ticks, with kept results reused as on a `github` repo.

**Before and after.** The scan reads `repos.yaml` from main, so a config PR setting a repo's
`change_source` to `github` for a measured window, then back to `clickhouse`, compares the two on one
release in the tick's per-repo request log lines. Leave out the first ticks after each switch: a
switch back starts with a full tick, and its second tick fetches the window again.
