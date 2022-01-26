import CommitStatus from "components/CommitStatus";
import ErrorBoundary from "components/ErrorBoundary";
import { PRData } from "lib/types";
import { useRouter } from "next/router";
import React from "react";
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
  const { data: commit, error } = useSWR(
    sha != null ? `/api/${repoOwner}/${repoName}/commit/${sha}` : null,
    fetcher,
    {
      refreshInterval: 60 * 1000, // refresh every minute
      // Refresh even when the user isn't looking, so that switching to the tab
      // will always have fresh info.
      refreshWhenHidden: true,
    }
  );
  if (error != null) {
    return <div>Error occured</div>;
  }

  if (commit === undefined) {
    return <div>Loading...</div>;
  }

  return <CommitStatus commit={commit} />;
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
        defaultValue={selectedSha}
        onChange={(e) => {
          router.push(
            `/${repoName}/${repoOwner}/pull/${pr}?sha=${e.target.value}`
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

  const { data } = useSWR(swrKey, fetcher, {
    refreshInterval: 60 * 1000, // refresh every minute
    // Refresh even when the user isn't looking, so that switching to the tab
    // will always have fresh info.
    refreshWhenHidden: true,
  });
  const prData = data as PRData | undefined;

  if (prData === undefined) {
    return <div>Loading...</div>;
  }

  const selectedSha = (sha ??
    prData.shas[prData.shas.length - 1].sha) as string;
  return (
    <div>
      <h1>
        {prData.title} <code>{router.query.pr}</code>
      </h1>
      <CommitHeader
        repoOwner={repoOwner as string}
        repoName={repoName as string}
        prData={prData}
        selectedSha={selectedSha}
      />
      <ErrorBoundary>
        <CommitInfo
          repoOwner={repoOwner as string}
          repoName={repoName as string}
          sha={selectedSha}
        />
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
