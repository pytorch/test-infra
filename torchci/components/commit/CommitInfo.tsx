import CommitStatus from "components/commit/CommitStatus";
import { fetcher } from "lib/GeneralUtils";
import { CommitApiResponse } from "pages/api/[repoOwner]/[repoName]/commit/[sha]";
import { IssueLabelApiResponse } from "pages/api/issue/[label]";
import useSWR from "swr";

export function CommitInfo({
  repoOwner,
  repoName,
  sha,
  isCommitPage,
}: {
  repoOwner: string;
  repoName: string;
  sha: string;
  isCommitPage: boolean;
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
