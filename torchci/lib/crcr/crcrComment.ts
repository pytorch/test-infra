// Renders the CRCR DOWNSTREAM section of the Dr. CI comment.
//
// Downstream CRCR jobs arrive as one row per job, named
// `crcr/<owner>/<repo>/<workflow>/<job>`, which reads as N unrelated problems
// when a single backend is simply down. This module groups them into one
// <details> block per downstream repo, so the repo -- the unit of ownership, and
// the unit the allowlist's `oncalls` list is keyed by -- is what the reader sees.
// Both L3 (advisory) and L4 (blocking) failures are reported here; the level in
// the summary says which this block is.
//
// The on-call pin lives in the summary line and in one sentence under the jobs,
// rather than in the standalone comment crcrOncallBot used to post. GitHub
// notifies every @-mention in a comment whenever that comment is EDITED, and the
// Dr. CI comment is rewritten every 15 minutes, so a pin has to be spent exactly
// once per (repo, person) -- one repo's recovery must not leave another repo's
// mention unspent. `notifiedHandlesByRepo` and `takeUnnotified` are that logic.

import { RecentWorkflowsData } from "lib/types";

// Written next to each mention once that on-call has been notified for that
// repo. The repo is part of the key on purpose; see takeUnnotified.
const PIN_MARKER_PREFIX = "<!-- crcr-pinned:";
const PIN_MARKER_SUFFIX = " -->";

// The marker that records one (repo, handle) pair as notified. Neither a repo
// name nor a handle can contain `:`, so the first one after the prefix separates
// them; a team handle keeps its own `/`.
function pinnedMarker(repo: string, handle: string): string {
  return `${PIN_MARKER_PREFIX}${repo}:${handle}${PIN_MARKER_SUFFIX}`;
}

// Every pin marker in `text`, in the order written. One place owns the marker
// grammar so the read (notifiedHandlesByRepo) and the copy (pinLedger) cannot
// drift apart.
function pinMarkers(
  text: string
): { repo: string; handle: string; marker: string }[] {
  const found: { repo: string; handle: string; marker: string }[] = [];
  const re =
    /<!-- crcr-pinned:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+):([A-Za-z0-9/_-]+) -->/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    found.push({ repo: match[1], handle: match[2], marker: match[0] });
  }
  return found;
}

// A handle from the allowlist lands in a public comment, so it is validated
// rather than escaped: it must not be able to inject markup, or a marker of its
// own, into the body. The CRCR on-call bot this replaces interpolated the value
// with no validation at all.
//
// One name segment: alphanumeric ends, interior single `-` or `_`. Teams are
// `org/team`, matching the reviewer logins lib/prStatus.ts accepts. See
// isSafeHandle for why the trailing-separator rule is also stated in code.
const SAFE_NAME_SEGMENT = "[A-Za-z0-9](?:[_-]?[A-Za-z0-9])*";
const SAFE_HANDLE_RE = new RegExp(
  `^${SAFE_NAME_SEGMENT}(?:/${SAFE_NAME_SEGMENT})?$`
);

/**
 * Whether a handle can be mentioned as written.
 *
 * The load-bearing rule is that a separator may only sit between alphanumerics:
 * GitHub does not treat a trailing `-` or `_` as part of a login, so `@trail-`
 * resolves to `trail` -- the comment would page somebody who is not on the
 * allowlist while this module recorded a pin for a handle it never mentioned.
 *
 * SAFE_HANDLE_RE already rejects those forms; the guard repeats the rule on
 * purpose, so it is stated where a reader looks for it and survives a later edit
 * to the pattern. An earlier version of the pattern let `_` end a name, which is
 * exactly the edit this guards against.
 */
export function isSafeHandle(handle: string): boolean {
  return SAFE_HANDLE_RE.test(handle) && !/[_-]$/.test(handle);
}

// Delimiters around the rendered section. The sweep rebuilds the whole comment
// and does not need them to render, but the pin state is read back OUT of the
// section between them -- see notifiedHandles.
export const CRCR_SECTION_START = "<!-- crcr-section-start -->";
export const CRCR_SECTION_END = "<!-- crcr-section-end -->";

// Kept close to the header the flat job list used, so the section reads the same
// in the comment; each block carries its own level, including for L4.
const SECTION_SUMMARY =
  "<b>CRCR DOWNSTREAM</b> - Downstream CI from repos the cross-repo relay reported on this PR. L3 is advisory, L4 blocks the merge:";

// Above this many job bullets, list the first few and summarize the rest. A
// repo whose whole matrix is red is exactly the case this section exists for, so
// the cap is high enough that it rarely engages.
export const MAX_JOB_BULLETS_PER_REPO = 10;

// The rendered section, or "" when either delimiter is missing (a comment that
// has none, or one whose section was already removed). Includes the trailing
// newline the renderer writes, the way extractPrStatusSection does, so a sweep
// that keeps the section rather than rebuilding it produces the same body.
export function extractCrcrSection(body: string): string {
  const start = body.indexOf(CRCR_SECTION_START);
  if (start === -1) {
    return "";
  }
  const endMarker = body.indexOf(CRCR_SECTION_END, start);
  if (endMarker === -1) {
    return "";
  }
  const end = endMarker + CRCR_SECTION_END.length;
  return body.slice(start, body[end] === "\n" ? end + 1 : end);
}

/**
 * Breaks up this module's control strings in downstream-supplied text.
 *
 * Workflow names, job names, the run URL and the reported conclusion all come
 * from the downstream callback and are rendered into the Dr. CI comment -- in the
 * section, and in the generic job list the caller falls back to -- while the
 * section's delimiters and pin markers are read back out of that same comment. A
 * name holding the start delimiter would make the section parse from the wrong
 * place, and one holding a pin marker would record somebody as paged who no sweep
 * ever mentioned (never paging them). `<!-- crcr-` has no business in any of
 * those fields, so it is defused rather than trusted not to appear -- the same
 * treatment handles get, by validation (see isSafeHandle).
 *
 * Applied where the CRCR rows are built (lib/fetchRecentWorkflows.ts), so every
 * consumer gets safe text, and again at render time here, because a renderer that
 * only works on pre-cleaned input is one refactor away from being wrong. The repo
 * and level need neither: the relay writes them from the allowlist it verified,
 * and a GitHub repo name cannot contain `<`.
 */
export function withoutControlMarkers(text: string): string {
  return text.replace(/<!--\s*crcr-/gi, "<!- -crcr-");
}

// On-calls whose marker already appears in the section, per repo. Reading these
// off the comment being replaced is what stops a rewrite from notifying them
// again.
//
// Scoped to the section on purpose. A marker is a plain HTML comment, so it can
// be quoted into any comment on the PR; matching the whole body would let a
// discussion that mentions one suppress a real page for the rest of the PR.
//
// The marker is keyed by (repo, handle). Per HANDLE alone it would outlive the
// repo that spent it: a login on call for two repos would stay pinned while
// either of them is red, so an independent outage in the repo that recovered
// would never be mentioned. Per REPO alone it would never notify an on-call
// added to the allowlist after the first failure. Markers are only as durable as
// the block holding them, so an on-call dropped from the allowlist while the
// block is rendered loses theirs and would be notified again if the repo failed
// after they were re-added -- acceptable for a rare flap, and better than
// re-notifying everyone each time the block is rewritten.
export function notifiedHandlesByRepo(body: string): Map<string, Set<string>> {
  const byRepo = new Map<string, Set<string>>();
  for (const { repo, handle } of pinMarkers(extractCrcrSection(body))) {
    byRepo.set(repo, new Set([...(byRepo.get(repo) ?? []), handle]));
  }
  return byRepo;
}

// Every handle pinned in `body`, across repos. Used by tests and by callers that
// only need to know whether anybody at all has been paged.
export function notifiedHandles(body: string): Set<string> {
  const handles = new Set<string>();
  for (const perRepo of notifiedHandlesByRepo(body).values()) {
    for (const handle of perRepo) {
      handles.add(handle);
    }
  }
  return handles;
}

/**
 * A section holding only the pin markers found in `body`, with no blocks.
 *
 * drciBot rewrites the Dr. CI comment on `pull_request.opened` and
 * `pull_request.synchronize` with no CI results to put back, so without this the
 * markers recording who has been paged would be wiped on every push -- the most
 * frequent trigger there is -- and the next sweep would mention every on-call
 * again for a failure they were already told about. The ledger carries the pins
 * across that rewrite and nothing else: the comment is left without a failure
 * block the push may have just invalidated, and the next sweep renders the real
 * section, dropping the ledger if the failure is gone.
 */
export function pinLedger(body: string): string {
  // Copied verbatim rather than rebuilt from the (repo, handle) pairs, so a
  // ledger is exactly the pins it was given and re-ledgering one is the
  // identity -- the sweep's early return depends on that.
  const markers = pinMarkers(extractCrcrSection(body)).map((p) => p.marker);
  if (markers.length === 0) {
    return "";
  }
  return (
    `${CRCR_SECTION_START}\n` + markers.join("") + `\n${CRCR_SECTION_END}\n`
  );
}

/**
 * Whether a section holds blocks to show, as opposed to being the pin ledger.
 *
 * The ledger is delimiters and markers only: it renders nothing, but it has to
 * stay in the body for the pins to survive. A caller deciding whether the
 * section can stand in for the generic job list therefore cannot go on the
 * string being non-empty -- that is the ledger too -- or it would leave the
 * failures counted in the title and listed nowhere. Every rendered section opens
 * with the block wrapper, and a ledger is built from validated handles, so it
 * cannot contain one.
 */
export function crcrSectionHasBlocks(section: string): boolean {
  return section.includes("<details");
}

/**
 * One row per job, at the latest attempt of its latest run.
 *
 * A re-run of a downstream workflow writes a NEW row rather than updating the
 * old one, so a job that failed and was then re-run green has both a red and a
 * green row here. GitHub's checks UI surfaces one check run per job name, and
 * the comment has to resolve to one row as well -- otherwise a rerun that fixed
 * the failure would still be reported as red, and one job would count twice in
 * the "N of M jobs failed" ratio.
 *
 * "Latest" is the newest run first and the highest attempt within it, not the
 * highest attempt overall: `run_attempt` counts attempts of ONE run and starts
 * over at 1 for the next, so a re-dispatch for a commit already reported on (a
 * reopen, say) writes attempt 1 of a run that supersedes the older run's
 * retries. Runs are ordered by `run_id`, which grows with each one; a row that
 * names no run cannot be placed in time and sorts with the oldest.
 *
 * It is also among the rows that reported a conclusion, because a row that
 * never did cannot supersede one that did -- see the filter below.
 */
export function latestAttemptPerJob(
  jobs: RecentWorkflowsData[]
): RecentWorkflowsData[] {
  // Keyed by the rendered job name, which the check run name makes unique across
  // workflows (`crcr/<repo>/<workflow>/<job>`). Keying on the bare `jobName`
  // would collapse two workflows of one repo that both have a "test" job.
  const byJob = new Map<string, RecentWorkflowsData[]>();
  for (const job of jobs) {
    byJob.set(job.name, [...(byJob.get(job.name) ?? []), job]);
  }

  const latest: RecentWorkflowsData[] = [];
  for (const attempts of byJob.values()) {
    // An attempt that never reported a conclusion says nothing about the job, so
    // it must not outrank one that did. Taking the highest attempt blindly lets
    // a later conclusion-less row report the job as not-failed when an earlier
    // attempt reported a failure -- a missed page, and for L4 a missed blocker.
    // Rows that did report are the candidates whenever there are any; a job whose
    // every row is conclusion-less still keeps its latest one, so the job stays
    // in the "N of M" denominator.
    const known = attempts.filter((job) => (job.conclusion ?? "") !== "");
    const candidates = known.length > 0 ? known : attempts;
    // Ties happen when the downstream action omits run_attempt: the relay
    // defaults it to 1, so two genuine attempts can both claim attempt 1 and the
    // survivor would otherwise be whichever row the table returned. Break the
    // tie on the conclusion -- reporting a green run as red is noise, but
    // reporting a red run as green is a missed page.
    const best = candidates.reduce((a, b) => {
      // The run first: an attempt only orders rows inside its own run.
      const runDiff = (b.runId ?? 0) - (a.runId ?? 0);
      if (runDiff !== 0) {
        return runDiff > 0 ? b : a;
      }
      const attemptDiff = (b.runAttempt ?? 1) - (a.runAttempt ?? 1);
      if (attemptDiff !== 0) {
        return attemptDiff > 0 ? b : a;
      }
      if (
        isFailureConclusion(a.conclusion) !== isFailureConclusion(b.conclusion)
      ) {
        return isFailureConclusion(b.conclusion) ? b : a;
      }
      return a;
    });
    latest.push(best);
  }
  return latest;
}

function isFailureConclusion(conclusion: string | undefined): boolean {
  return ["failure", "cancelled", "timed_out"].includes(conclusion ?? "");
}

/**
 * The rows that describe the commit the comment reports on: `headSha`'s rows,
 * one per job, at the latest attempt of its latest run.
 *
 * The head filter runs BEFORE attempts are resolved, and the order is the point.
 * A run of a superseded push can be re-run after the new push, so the highest
 * attempt for a job can belong to the old commit; resolving attempts first would
 * hand the job to that stale row and the head filter would then drop it --
 * deleting a real failure from the comment, and for an L4 job a blocking one.
 *
 * Rows with no head SHA are rows whose commit is unknown. They are kept, but only
 * for a job this commit has no row for: an unknown commit must not outrank a
 * known result for the same job, or the failure tie-break inside
 * latestAttemptPerJob would let an old red row keep a job red -- and at L4
 * blocking -- after this commit's run passed.
 */
export function latestAttemptsForHead(
  jobs: RecentWorkflowsData[],
  headSha: string
): RecentWorkflowsData[] {
  const forHead = jobs.filter(
    (job) => !job.head_sha || job.head_sha === headSha
  );
  const jobsOnThisCommit = new Set(
    forHead.filter((job) => job.head_sha === headSha).map((job) => job.name)
  );
  return latestAttemptPerJob(
    forHead.filter(
      (job) => job.head_sha === headSha || !jobsOnThisCommit.has(job.name)
    )
  );
}

/**
 * Builds the grouped section.
 *
 * `failedByRepo` carries only the repos that have failures: a repo that ran and
 * passed is not rendered, because the section -- and the comment it sits in --
 * only exists to report failures.
 *
 * Which pins are spent is carried by the markers in the returned text and read
 * back on the next sweep by `notifiedHandles`; nothing else needs threading.
 */
export function renderCrcrSection(
  failedByRepo: Map<string, RecentWorkflowsData[]>,
  totalByRepo: Map<string, number>,
  // Base of the HUD PR page, e.g. https://hud.pytorch.org/pr/pytorch/pytorch/123.
  // Job links carry the job id as a fragment, the same deep link the other Dr. CI
  // sections use.
  hudPrUrl: string,
  onCallsFor: (_repo: string) => string[],
  // On-calls already notified on an earlier sweep, per downstream repo.
  notified: Map<string, Set<string>>
): string {
  if (failedByRepo.size === 0) {
    return "";
  }

  const blocks = Array.from(failedByRepo.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((repo) =>
      renderRepoBlock(
        repo,
        failedByRepo.get(repo)!,
        totalByRepo.get(repo),
        hudPrUrl,
        onCallsFor,
        // This repo's own pins: a handle on call for two repos is mentioned for
        // each of them, so one repo recovering does not silence the other's
        // next outage.
        notified.get(repo) ?? new Set()
      )
    )
    .join("");

  return (
    `${CRCR_SECTION_START}\n` +
    `<details ><summary>${SECTION_SUMMARY}</summary><p>\n` +
    blocks +
    `\n</p></details>\n${CRCR_SECTION_END}\n`
  );
}

/**
 * The CRCR section a sweep should put in the comment.
 *
 * A sweep may fail to work out what the section should say while still being
 * able to rebuild the rest of the comment -- the CRCR rows may not be readable,
 * or the allowlist that supplies the pins may not be. It must not, in that case,
 * drop the `crcr-pinned` markers: they ARE the record of who has been paged, so a
 * pin-less rewrite pages every on-call again on the next sweep. It must not keep
 * the blocks either: those describe an older sweep, and a read that keeps failing
 * would leave them standing indefinitely, with links to jobs that may be gone.
 *
 * So an unreadable sweep keeps the pins and nothing else. The pin ledger renders
 * nothing, which also leaves the caller's generic list to report the L3 failures
 * this sweep does know -- all of them when only the allowlist read failed, none
 * when the rows themselves failed (the comment is incomplete for that sweep
 * either way, and recovers on the next one):
 *
 *   rows unreadable          -> the ledger (the pins, no blocks)
 *   read, no failures        -> "" (the failure cleared; its pins are freed)
 *   read, failures, allowlist-> render, spending any unpinned handle
 *   read, failures, no list  -> the ledger, or "" when there are no pins, which
 *                               leaves the caller's flat list to report them
 *
 * `onCallsFor === null` means "could not read", which is deliberately not the
 * same as "this repo has no on-calls": the latter renders an explicit line,
 * because reporting a missing allowlist entry is useful and reporting a failed
 * read as one is a lie.
 */
export function crcrSectionForSweep(
  // The comment being replaced. Its section holds the pins spent so far.
  previousBody: string,
  failedByRepo: Map<string, RecentWorkflowsData[]>,
  totalByRepo: Map<string, number>,
  hudPrUrl: string,
  onCallsFor: ((_repo: string) => string[]) | null,
  // False when the CRCR rows could not be read at all.
  rowsRead: boolean
): string {
  if (!rowsRead) {
    return pinLedger(previousBody);
  }
  if (failedByRepo.size === 0) {
    // The failures are gone, which is known without the allowlist: drop the
    // section and free its pins for a later outage.
    return "";
  }
  if (onCallsFor === null) {
    return pinLedger(previousBody);
  }
  return renderCrcrSection(
    failedByRepo,
    totalByRepo,
    hudPrUrl,
    onCallsFor,
    // The pins are read out of the section being replaced, so it is also what
    // keeps this render from re-notifying anyone.
    notifiedHandlesByRepo(previousBody)
  );
}

function renderRepoBlock(
  repo: string,
  failed: RecentWorkflowsData[],
  total: number | undefined,
  hudPrUrl: string,
  onCallsFor: (_repo: string) => string[],
  // Handles already notified for THIS repo, whose markers this block carries
  // forward so the next sweep still reads the pin.
  notified: Set<string>
): string {
  const jobs = [...failed].sort((a, b) => a.name.localeCompare(b.name));
  // A repo's level is fixed in the allowlist and flips as a whole, so taking it
  // from any job is the same answer; the sort just makes WHICH job that is
  // deterministic. Rows carrying two levels at once only happen mid-rollout, and
  // then the lower-sorting name wins.
  const level = jobs[0].downstreamLevel || "L3";
  const oncalls = onCallsFor(repo);
  const { mentionNow, alreadyNotified } = takeUnnotified(oncalls, notified);

  // `2 of 4 jobs failed` tells a reader whether one leg flaked or the backend is
  // down; without a trustworthy denominator, the failing count alone. The total
  // counts still-running jobs too, so a matrix mid-flight does not read as a
  // small matrix that all failed. A total below the failing count is stale data,
  // not a ratio worth printing.
  const ratio =
    total !== undefined && total >= jobs.length
      ? `${jobs.length} of ${total} jobs failed`
      : `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"} failed`;
  // The summary mirrors the sentence below: only the people being mentioned NOW
  // get the `@`, because a mention anywhere in the rewritten comment notifies.
  // People notified earlier are listed first so the new `@` is what stands out.
  const allNames = [
    ...alreadyNotified,
    ...mentionNow.map((handle) => `@${handle}`),
  ];
  const summary =
    `<b>${repo}</b> · ${level}${
      level === "L4" ? " (blocking)" : ""
    } · ${ratio}` +
    (allNames.length > 0 ? ` · on-call ${allNames.join(" ")}` : "");

  let out = `\n<details><summary>${summary}</summary><p>\n\n`;
  for (const job of jobs.slice(0, MAX_JOB_BULLETS_PER_REPO)) {
    // The HUD deep link is the one with the failure's log and captures; the
    // check run link in `html_url` is the downstream workflow run. Every field
    // here is downstream-supplied, so it is defused before it lands between the
    // section's delimiters -- see withoutControlMarkers.
    const name = withoutControlMarkers(job.name);
    const url = withoutControlMarkers(job.html_url);
    const conclusion = withoutControlMarkers(job.conclusion ?? "");
    out += `* [${name}](${hudPrUrl}#${job.id}) ([gh](${url})) — \`${conclusion}\`\n`;
  }
  if (jobs.length > MAX_JOB_BULLETS_PER_REPO) {
    out += `* …and ${jobs.length - MAX_JOB_BULLETS_PER_REPO} more\n`;
  }

  out += renderPin(repo, mentionNow, alreadyNotified, {
    // Told apart so the block only claims "no on-call is configured" when the
    // allowlist really has none, rather than when every entry was unusable.
    hasNoOnCalls: oncalls.length === 0,
    // An L4 failure holds the merge, and telling its on-call otherwise would send
    // them away from a blocking failure.
    blocking: level === "L4",
  });
  return out + `\n</p></details>\n`;
}

/**
 * Splits a repo's on-calls into the handles this render mentions and the ones
 * already notified for this repo. The set is per repo: a login on call for two
 * repos is mentioned once for each, so when one of those repos recovers and
 * fails again the new outage is mentioned again even while the other is still
 * red. A repeat is the cheaper error -- a missed mention is a failure nobody was
 * told about.
 */
function takeUnnotified(
  oncalls: string[],
  notified: Set<string>
): { mentionNow: string[]; alreadyNotified: string[] } {
  const mentionNow: string[] = [];
  const alreadyNotified: string[] = [];
  for (const raw of new Set(oncalls)) {
    // The allowlist's own header documents `[@oncall1, @oncall2]`, and neither
    // parser strips the `@`, so tolerate it rather than silently dropping the
    // entry -- the mention is added back at render time.
    const handle = raw.startsWith("@") ? raw.slice(1) : raw;
    if (!isSafeHandle(handle)) {
      continue;
    }
    (notified.has(handle) ? alreadyNotified : mentionNow).push(handle);
  }
  return { mentionNow, alreadyNotified };
}

function renderPin(
  repo: string,
  mentionNow: string[],
  alreadyNotified: string[],
  opts: {
    // True only when the allowlist entry has no on-calls at all. A repo with none
    // says so rather than rendering nothing, which is what today's bot does -- it
    // skips the comment entirely, leaving the failure invisible on the PR.
    hasNoOnCalls: boolean;
    blocking: boolean;
  }
): string {
  const { hasNoOnCalls, blocking } = opts;
  // Every handle this block knows about is marked, not only the ones mentioned
  // here. The markers ARE the pin state, read back on the next sweep, so a marker
  // that stops being emitted re-notifies that person on the sweep after --
  // omitting the already-notified is what turns one notification into one per
  // sweep.
  const markers = (handles: string[]) =>
    handles.map((handle) => pinnedMarker(repo, handle)).join("");

  if (mentionNow.length === 0) {
    if (alreadyNotified.length === 0) {
      return hasNoOnCalls
        ? `\nNo on-call is configured for this repo in \`.github/allowlist.yml\`.\n`
        : "";
    }
    return (
      `\n${markers(alreadyNotified)}` +
      `On-call ${alreadyNotified.join(", ")} ${
        alreadyNotified.length === 1 ? "has" : "have"
      } been notified.\n`
    );
  }

  // Someone new alongside people already notified: name the latter as plain
  // text, so this rewrite cannot notify them a second time.
  const alsoNotified =
    alreadyNotified.length > 0
      ? ` ${alreadyNotified.join(", ")} ` +
        `${
          alreadyNotified.length === 1 ? "has" : "have"
        } already been notified.`
      : "";
  return (
    `\n${markers(mentionNow)}${markers(alreadyNotified)}` +
    `${mentionNow.map((l) => `@${l}`).join(" ")} — please investigate. ` +
    (blocking
      ? `This is **blocking**: the merge is held until it passes or the check ` +
        `is dismissed. `
      : `This is **non-blocking** and does not hold the merge. `) +
    `Reply here if the failure looks like a PyTorch-side change.` +
    `${alsoNotified}\n`
  );
}
