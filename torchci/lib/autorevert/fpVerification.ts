// Shared PR-level false-positive verification used by the autorevert API
// endpoints under `pages/api/autorevert/`.
//
// PyTorch lands via `pytorchmergebot` cherry-pick, so GitHub's `merged_at` is
// unreliable — the `Merged` label is the truth signal that a PR shipped.

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

export function countCommitsAfter(commits: CommitLike[], cutoff: Date): number {
  return commits.filter((c) => {
    const ts = new Date(c.commit.committer?.date || c.commit.author?.date || 0);
    return ts > cutoff;
  }).length;
}

export function classifyFp(args: {
  pr: PrLike;
  commits: CommitLike[];
  revertTime: Date;
}): FpVerificationResult {
  const { pr, commits, revertTime } = args;
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

    return classifyFp({ pr, commits, revertTime });
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
