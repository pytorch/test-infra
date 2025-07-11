import CommitStatus from "components/commit/CommitStatus";
import { fetcher } from "lib/GeneralUtils";
import { CommitApiResponse } from "pages/api/[repoOwner]/[repoName]/commit/[sha]";
import { IssueLabelApiResponse } from "pages/api/issue/[label]";
import useSWR from "swr";

export default function CommitInfo({
  repoOwner,
  repoName,
  sha,
}: {
  repoOwner: string;
  repoName: string;
  sha: string;
}) {
  const {
    data: commitData,
    error,
    isLoading,
  } = useSWR<CommitApiResponse>(
    sha != null ? `/api/${repoOwner}/${repoName}/commit/${sha}` : null,
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
    return <div>Error occurred</div>;
  }

  if (isLoading) {
    return <div>Loading...</div>;
  }
  const { commit, jobs, workflowIdsByName } = commitData!;

  return (
    <CommitStatus
      repoOwner={repoOwner}
      repoName={repoName}
      commit={commit}
      jobs={jobs}
      workflowIdsByName={workflowIdsByName}
      isCommitPage={false}
      unstableIssues={unstableIssuesData ?? []}
    />
  );
}
