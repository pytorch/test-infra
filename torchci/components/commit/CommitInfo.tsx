import CommitStatus from "components/commit/CommitStatus";
import GreenLightSection from "components/greenlight/GreenLightSection";
import { fetcher } from "lib/GeneralUtils";
import { CommitApiResponse } from "pages/api/[repoOwner]/[repoName]/commit/[sha]";
import { IssueLabelApiResponse } from "pages/api/issue/[label]";
import useSWR from "swr";

export function CommitInfo({
  repoOwner,
  repoName,
  sha,
  isCommitPage,
  prNumber,
}: {
  repoOwner: string;
  repoName: string;
  sha: string;
  isCommitPage: boolean;
  /**
   * The PR this commit belongs to, when the caller already knows it.
   *
   * `commit.prNum` is parsed out of the commit message, and only mergebot's
   * "Pull Request resolved: #N" line puts it there -- which it adds at merge
   * time. So a commit still sitting on a PR branch has no PR number in its
   * message at all, and the PR page (which does know the number, from its own
   * route) has to supply it or the GreenLight panel below silently finds
   * nothing to look up.
   */
  prNumber?: number | null;
}) {
  const { data: commitData, error } = useSWR<CommitApiResponse>(
    sha && `/api/${repoOwner}/${repoName}/commit/${sha}`,
    fetcher,
    {
      refreshInterval: 60 * 1000, // refresh every minute
      // Refresh even when the user isn't looking, so that switching to the tab
      // will always have fresh info.
      refreshWhenHidden: true,
    }
  );

  const { data: unstableIssuesData } = useSWR<IssueLabelApiResponse>(
    `/api/issue/unstable`,
    fetcher,
    {
      dedupingInterval: 300 * 1000,
      refreshInterval: 300 * 1000, // refresh every 5 minutes
    }
  );

  if (error != null) {
    return <div>Error occured</div>;
  }

  if (commitData === undefined) {
    return <div>Loading...</div>;
  }

  const { commit, jobs, workflowIdsByName } = commitData;

  return (
    <div>
      {isCommitPage && <h2>{commit.commitTitle}</h2>}
      {/* Above the job grid, not below it: the verdict is a statement about the
      whole change, and a reader who has scrolled past every workflow box has
      already stopped looking for one. Its own header carries the mark, so
      neither title above it needs one too. Shared with the PR page, which
      renders CommitInfo for whichever commit its picker has selected. */}
      <GreenLightSection
        repoOwner={repoOwner}
        repoName={repoName}
        prNumber={prNumber ?? commit.prNum}
        sha={sha}
      />
      <CommitStatus
        repoOwner={repoOwner}
        repoName={repoName}
        commit={commit}
        jobs={jobs}
        workflowIdsByName={workflowIdsByName}
        isCommitPage={isCommitPage}
        unstableIssues={unstableIssuesData ?? []}
      />
    </div>
  );
}
