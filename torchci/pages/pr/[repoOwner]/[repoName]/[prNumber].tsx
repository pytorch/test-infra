import CommitStatus from "components/CommitStatus";
import ErrorBoundary from "components/ErrorBoundary";
import { PRData } from "lib/types";
import { useRouter } from "next/router";
import React from "react";
import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

function CommitInfo({ sha }: { sha: string }) {
  const { data: commit, error } = useSWR(
    sha != null ? `/api/commit/${sha}` : null,
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
  prData,
  selectedSha,
}: {
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
          router.push(`/pr/pytorch/pytorch/${pr}?sha=${e.target.value}`);
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

  let swrKey;
  if (router.query.prNumber !== undefined) {
    swrKey = `/api/pr/${router.query.prNumber}`;
  }
  if (router.query.sha !== undefined) {
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

  const sha =
    (router.query.sha as string) ?? prData.shas[prData.shas.length - 1].sha;
  return (
    <div>
      <h1>
        {prData.title} <code>{router.query.pr}</code>
      </h1>
      <CommitHeader prData={prData} selectedSha={sha} />
      <ErrorBoundary>
        <CommitInfo sha={sha} />
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
