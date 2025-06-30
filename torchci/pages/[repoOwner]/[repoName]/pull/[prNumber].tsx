import { Stack } from "@mui/material";
import CommitStatus from "components/commit/CommitStatus";
import DrCIButton from "components/common/DrCIButton";
import ErrorBoundary from "components/common/ErrorBoundary";
import { useSetTitle } from "components/layout/DynamicTitle";
import { PRData } from "lib/types";
import { useRouter } from "next/router";
import { CommitApiResponse } from "pages/api/[repoOwner]/[repoName]/commit/[sha]";
import { IssueLabelApiResponse } from "pages/api/issue/[label]";
import { useEffect, useState } from "react";
import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

function CommitInfo({
  repoOwner,
  repoName,
  sha,
}: {
  repoOwner: string;
  repoName: string;
  sha: string;
}) {
  const { data: commitData, error } = useSWR<CommitApiResponse>(
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

  if (commitData === undefined) {
    return <div>Loading...</div>;
  }
  const { commit, jobs } = commitData;

  return (
    <CommitStatus
      repoOwner={repoOwner}
      repoName={repoName}
      commit={commit}
      jobs={jobs}
      isCommitPage={false}
      unstableIssues={unstableIssuesData ?? []}
    />
  );
}

function CommitHeader({
  repoOwner,
  repoName,
  prData,
  selectedSha,
}: {
  repoOwner: string;
  repoName: string;
  prData: PRData;
  selectedSha: string;
}) {
  const router = useRouter();
  const pr = router.query.prNumber as string;
  return (
    <div>
      Commit:{" "}
      <select
        value={selectedSha}
        onChange={(e) => {
          router.push(
            `/${repoOwner}/${repoName}/pull/${pr}?sha=${e.target.value}`
          );
        }}
      >
        {prData.shas.map(({ sha, title }) => (
          <option key={sha} value={sha}>
            {title + ` (${sha.substring(0, 6)})`}
          </option>
        ))}
      </select>
    </div>
  );
}

function Page() {
  const router = useRouter();

  const { repoOwner, repoName, prNumber, sha } = router.query;

  let swrKey;
  if (prNumber !== undefined) {
    swrKey = `/api/${repoOwner}/${repoName}/pull/${router.query.prNumber}`;
  }
  if (sha !== undefined) {
    swrKey += `?sha=${router.query.sha}`;
  }
  const { data: prData } = useSWR<PRData>(swrKey, fetcher, {
    refreshInterval: 60 * 1000, // refresh every minute
    // Refresh even when the user isn't looking, so that switching to the tab
    // will always have fresh info.
    refreshWhenHidden: true,
  });
  const [selectedSha, setSelectedSha] = useState("");

  useEffect(() => {
    const selected = (sha ??
      (prData && prData.shas.length > 0
        ? prData?.shas[prData.shas.length - 1].sha
        : "")) as string;
    setSelectedSha(selected);
  }, [prData?.shas, sha]);

  useSetTitle(`${prData?.title} #${prNumber}`);

  if (prData === undefined) {
    return <div>Loading...</div>;
  }

  return (
    <div>
      <Stack
        direction="row"
        spacing={0}
        sx={{
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <h1>
          {prData.title}{" "}
          <code>
            <a
              href={`https://github.com/${repoOwner}/${repoName}/pull/${prNumber}`}
            >
              #{prNumber}
            </a>
          </code>
        </h1>
        <DrCIButton
          prNumber={prNumber ? parseInt(prNumber as string) : 0}
          owner={repoOwner as string}
          repo={repoName as string}
        />
      </Stack>
      {selectedSha === "" && <div>Empty pull request without any commit</div>}
      {selectedSha !== "" && (
        <CommitHeader
          repoOwner={repoOwner as string}
          repoName={repoName as string}
          prData={prData}
          selectedSha={selectedSha}
        />
      )}
      <ErrorBoundary>
        {selectedSha !== "" && (
          <CommitInfo
            repoOwner={repoOwner as string}
            repoName={repoName as string}
            sha={selectedSha}
          />
        )}
      </ErrorBoundary>
    </div>
  );
}

export default function PageWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <Page />
    </ErrorBoundary>
  );
}
