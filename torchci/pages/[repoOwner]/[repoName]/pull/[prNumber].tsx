import CommitStatus from "components/CommitStatus";
import { useSetTitle } from "components/DynamicTitle";
import ErrorBoundary from "components/ErrorBoundary";
import { useCHContext } from "components/UseClickhouseProvider";
import { PRData } from "lib/types";
import { useRouter } from "next/router";
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
  const useCH = useCHContext().useCH;
  const { data: commitData, error } = useSWR(
    sha != null
      ? `/api/${repoOwner}/${repoName}/commit/${sha}?use_ch=${useCH}`
      : null,
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
      unstableIssues={unstableIssuesData ? unstableIssuesData.issues : []}
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
  const { data } = useSWR(swrKey, fetcher, {
    refreshInterval: 60 * 1000, // refresh every minute
    // Refresh even when the user isn't looking, so that switching to the tab
    // will always have fresh info.
    refreshWhenHidden: true,
  });
  const [selectedSha, setSelectedSha] = useState("");

  const prData = data as PRData | undefined;

  useEffect(() => {
    const selected = (sha ??
      prData?.shas[prData.shas.length - 1].sha ??
      "") as string;
    setSelectedSha(selected);
  }, [prData?.shas, sha]);

  useSetTitle(`${prData?.title} #${prNumber}`);

  if (prData === undefined) {
    return <div>Loading...</div>;
  }
  return (
    <div>
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
