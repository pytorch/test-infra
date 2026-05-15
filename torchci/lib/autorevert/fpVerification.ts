// Shared PR-level false-positive verification used by the autorevert API
// endpoints under `pages/api/autorevert/`.
//
// PyTorch lands via `pytorchmergebot` cherry-pick, so GitHub's `merged_at` is
// unreliable — the `Merged` label is the truth signal that a PR shipped. But
// both `Merged` and `Reverted` labels are STICKY — added by mergebot on each
// cycle and never removed even after a subsequent revert. A PR that goes
// merge → revert → abandon-without-reland still carries the `Merged` label,
// looks "closed-and-was-merged-with-no-post-revert-commits", and would be
// mis-classified as a confirmed FP if we trusted only the label state.
//
// The decisive signal for abandonment is the actor of the LAST `closed`
// timeline event. If the PR's terminal close is by someone other than
// `pytorchmergebot` (typically the PR author or a maintainer), the human
// stepped in to give up on relanding via this PR — that's a legitimate
// revert, not an autorevert false positive.
//
// See: https://github.com/pytorch/pytorch/pull/182078 for a canonical case.

export const MERGEBOT_LOGIN = "pytorchmergebot";

export interface FpVerificationResult {
  pr_state: string;
  pr_merged: boolean;
  commits_after_revert: number;
  verification_status: "confirmed_fp" | "legit_revert" | "unknown";
  verification_reason: string;
}

interface PrLike {
  state: string;
  labels?: Array<{ name: string }>;
}

interface CommitLike {
  commit: {
    committer?: { date?: string };
    author?: { date?: string };
  };
}

interface TimelineEventLike {
  event: string;
  actor?: { login?: string } | null;
}

export function countCommitsAfter(commits: CommitLike[], cutoff: Date): number {
  return commits.filter((c) => {
    const ts = new Date(c.commit.committer?.date || c.commit.author?.date || 0);
    return ts > cutoff;
  }).length;
}

export function lastCloseActor(
  timeline: TimelineEventLike[]
): string | undefined {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const ev = timeline[i];
    if (ev.event === "closed") {
      return ev.actor?.login ?? undefined;
    }
  }
  return undefined;
}

function terminalCloseByHuman(timeline: TimelineEventLike[]): boolean {
  const actor = lastCloseActor(timeline);
  return actor !== undefined && actor !== MERGEBOT_LOGIN;
}

export function classifyFp(args: {
  pr: PrLike;
  commits: CommitLike[];
  timeline: TimelineEventLike[];
  revertTime: Date;
}): FpVerificationResult {
  const { pr, commits, timeline, revertTime } = args;
  const labelNames = (pr.labels ?? []).map((l) => l.name);
  const hasMergedLabel = labelNames.includes("Merged");
  const hasAutorevertDisable = labelNames.includes("autorevert: disable");
  const commitsAfterRevert = countCommitsAfter(commits, revertTime);

  let verificationStatus: FpVerificationResult["verification_status"];
  let verificationReason: string;

  if (hasAutorevertDisable) {
    verificationStatus = "confirmed_fp";
    verificationReason = "PR has 'autorevert: disable' label";
  } else if (pr.state === "open") {
    verificationStatus = "legit_revert";
    verificationReason = "PR is still open (not relanded)";
  } else if (commitsAfterRevert > 0) {
    verificationStatus = "legit_revert";
    verificationReason = `PR had ${commitsAfterRevert} commit(s) after revert (author fixed issues)`;
  } else if (terminalCloseByHuman(timeline)) {
    // PR was closed by someone other than pytorchmergebot — author abandoned
    // the PR after the revert rather than letting mergebot reland. The
    // `Merged` label is sticky from earlier cycles and cannot be trusted.
    const actor = lastCloseActor(timeline) ?? "non-mergebot";
    verificationStatus = "legit_revert";
    verificationReason = `PR was closed by ${actor} (not pytorchmergebot) — author abandoned after revert`;
  } else if (hasMergedLabel) {
    verificationStatus = "confirmed_fp";
    verificationReason =
      "PR was merged (has 'Merged' label) with no changes after revert";
  } else {
    verificationStatus = "legit_revert";
    verificationReason = "PR was closed without merging (abandoned)";
  }

  return {
    pr_state: pr.state,
    pr_merged: hasMergedLabel,
    commits_after_revert: commitsAfterRevert,
    verification_status: verificationStatus,
    verification_reason: verificationReason,
  };
}

export async function verifyFpForPr(
  octokit: any,
  prNumber: number,
  revertTime: Date
): Promise<FpVerificationResult> {
  try {
    const { data: pr } = await octokit.rest.pulls.get({
      owner: "pytorch",
      repo: "pytorch",
      pull_number: prNumber,
    });

    const commits = (await octokit.paginate(octokit.rest.pulls.listCommits, {
      owner: "pytorch",
      repo: "pytorch",
      pull_number: prNumber,
      per_page: 100,
    })) as CommitLike[];

    // Only fetch the timeline when we might need the actor check — i.e. the
    // PR is closed AND has no post-revert commits AND doesn't carry the
    // disable label. Open PRs short-circuit on step 2, PRs with post-revert
    // commits short-circuit on step 3, and the disable label is decisive.
    let timeline: TimelineEventLike[] = [];
    const labelNames = (pr.labels ?? []).map((l: any) => l.name);
    const needsTimeline =
      pr.state === "closed" &&
      !labelNames.includes("autorevert: disable") &&
      countCommitsAfter(commits, revertTime) === 0;
    if (needsTimeline) {
      timeline = (await octokit.paginate(
        octokit.rest.issues.listEventsForTimeline,
        {
          owner: "pytorch",
          repo: "pytorch",
          issue_number: prNumber,
          per_page: 100,
        }
      )) as TimelineEventLike[];
    }

    return classifyFp({ pr, commits, timeline, revertTime });
  } catch (error: any) {
    console.error(`Error verifying PR #${prNumber}:`, error.message);
    return {
      pr_state: "unknown",
      pr_merged: false,
      commits_after_revert: -1,
      verification_status: "unknown",
      verification_reason: `Failed to fetch PR data: ${error.message}`,
    };
  }
}
