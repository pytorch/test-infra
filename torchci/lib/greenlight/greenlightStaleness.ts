// Whether an in-flight misc.greenlight_pr_state row still counts as a live
// review, given the ClickHouse `version` timestamp it carries. Split out of
// greenlightRender.ts: parsing a zone-less DateTime64 and comparing it against a
// window is its own concern, and the renderer only asks the yes/no question.

// An AI_REVIEW_STARTED row older than this renders as "did not complete" rather
// than as a live review: the terminal emit was lost (the S3 -> ClickHouse
// replicator drops rows silently and never retries) and the row would otherwise
// show "in progress" forever.
// Sized off the longest real path from the in-flight row to the terminal one. The
// review job is capped at 40 minutes, bounding its 37-minute model step, and the
// record job that emits the verdict only starts after it; the worst prior-row age
// actually observed at record time is ~38 minutes. Deliberately WIDER than
// DEFAULT_TIMEOUT_MINUTES (45) in greenlight/constants.py, which is a different
// clock: that one governs when the scan re-dispatches, and a re-dispatch writes a
// row with a higher run_id that the greenlight_pr_states query prefers. So the
// extra width is only ever spent on a run nothing supersedes, while at 45 a
// queued runner was enough to call a review stalled that was about to finish.
export const GREENLIGHT_IN_PROGRESS_STALE_MS = 60 * 60 * 1000;

// ISO-shaped with an optional fractional part and NO zone designator.
const CLICKHOUSE_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;

// ClickHouse serves this column under date_time_output_format='iso' (see
// lib/clickhouse.ts), which for DateTime64 emits `2026-08-24T21:57:40.736000` --
// ISO-shaped but carrying no zone designator, which Date.parse reads as LOCAL
// time and would shift the staleness window by the host's offset. The HUD
// ClickHouse server timezone is UTC, so build the epoch explicitly; the
// Date.parse fallback only sees forms that do carry a zone. NaN when unparseable.
function parseVersionMs(version: string): number {
  const trimmed = (version || "").trim();
  const parts = CLICKHOUSE_DATETIME_RE.exec(trimmed);
  if (parts === null) {
    return Date.parse(trimmed);
  }
  const millis = (parts[7] ?? "").slice(0, 3).padEnd(3, "0");
  return Date.UTC(
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3]),
    Number(parts[4]),
    Number(parts[5]),
    Number(parts[6]),
    Number(millis)
  );
}

// Mirrors decision._aged_out, including its treatment of a missing version as
// already aged out. Distance in either direction: a timestamp further ahead of
// now than the window is as implausible as one that far behind it, and treating
// it as fresh would render "in progress" -- and keep emitting the re-render
// sentinel -- for as long as the row stands. Comparing the magnitude rather than
// clamping every negative age keeps a few seconds of clock skew between the
// writer and the HUD from reading as a stalled review.
export function isInProgressStale(version: string, now: Date): boolean {
  const versionMs = parseVersionMs(version);
  if (Number.isNaN(versionMs)) {
    return true;
  }
  return Math.abs(now.getTime() - versionMs) >= GREENLIGHT_IN_PROGRESS_STALE_MS;
}
