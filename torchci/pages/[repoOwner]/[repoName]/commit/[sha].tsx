import CommitStatus from "components/CommitStatus";
import { fetcher } from "lib/GeneralUtils";
import { useRouter } from "next/router";
import useSWR from "swr";
import { IssueData } from "lib/types";

export function CommitInfo({
  repoOwner,
  repoName,
  sha,
}: {
  repoOwner: string;
  repoName: string;
  sha: string;
}) {
  const { data: commitData, error } = useSWR(
    `/api/${repoOwner}/${repoName}/commit/${sha}`,
    fetcher,
    {
      refreshInterval: 60 * 1000, // refresh every minute
      // Refresh even when the user isn't looking, so that switching to the tab
      // will always have fresh info.
      refreshWhenHidden: true,
    }
  );

  const { data: unstableIssuesData } = useSWR(`/api/issue/unstable`, fetcher, {
    dedupingInterval: 300 * 1000,
    refreshInterval: 300 * 1000, // refresh every 5 minutes
  });

  if (error != null) {
    return <div>Error occured</div>;
  }

  if (commitData === undefined) {
    return <div>Loading...</div>;
  }

  const { commit, jobs } = commitData;
  return (
    <div>
      <h2>{commit.commitTitle}</h2>
      <CommitStatus
        repoOwner={repoOwner}
        repoName={repoName}
        commit={commit}
        jobs={jobs}
        isCommitPage={true}
        unstableIssues={unstableIssuesData ? unstableIssuesData.issues : []}
      />
    </div>
  );
}

export default function Page() {
  const router = useRouter();
  const { sha, repoOwner, repoName } = router.query;
  const fancyName =
    repoOwner === "pytorch" && repoName === "pytorch"
      ? "PyTorch"
      : repoOwner === "pytorch" && repoName === "vision"
      ? "TorchVision"
      : repoOwner === "pytorch" && repoName === "audio"
      ? "TorchAudio"
      : repoOwner === "pytorch" && repoName === "executorch"
      ? "ExecuTorch"
      : `${repoOwner}/${repoName}`;

  return (
    <div>
      <h1 id="hud-header">
        {fancyName} Commit: <code>{sha}</code>
      </h1>
      {sha !== undefined && (
        <CommitInfo
          repoOwner={repoOwner as string}
          repoName={repoName as string}
          sha={sha as string}
        />
      )}
    </div>
  );
}
