import { Button, CircularProgress, Stack, Tooltip } from "@mui/material";
import CommitStatus from "components/CommitStatus";
import { useSetTitle } from "components/DynamicTitle";
import ErrorBoundary from "components/ErrorBoundary";
import { useCHContext } from "components/UseClickhouseProvider";
import { PRData } from "lib/types";
import { useSession } from "next-auth/react";
import { useRouter } from "next/router";
import { IssueLabelApiResponse } from "pages/api/issue/[label]";
import { CommitApiResponse } from "pages/api/[repoOwner]/[repoName]/commit/[sha]";
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
  const { data: commitData, error } = useSWR<CommitApiResponse>(
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

function DrCIButton({
  owner,
  repo,
  prNumber,
}: {
  owner: string;
  repo: string;
  prNumber: number;
}) {
  const session = useSession();
  const loggedIn = session.status === "authenticated" && session.data !== null;
  // loading, clickable, failed, rateLimited
  const [buttonState, setButtonState] = useState("clickable");

  const url = `/api/drci/drci?prNumber=${prNumber}`;
  if (buttonState == "loading" && loggedIn) {
    fetch(url, {
      method: "POST",
      body: JSON.stringify({ repo: repo }),
      headers: {
        Authorization: session.data!["accessToken"],
        "Cache-Control": "no-cache",
      },
    }).then((res) => {
      if (res.status == 429) {
        setButtonState("rateLimited");
        return;
      }
      if (!res.ok) {
        setButtonState("failed");
        return;
      }
      setButtonState("clickable");
      return res.json();
    });
  }

  useEffect(() => {
    if (buttonState == "failed" || buttonState == "rateLimited") {
      setTimeout(() => {
        setButtonState("clickable");
      }, 5000);
    }
  }, [buttonState]);

  return (
    <Tooltip
      title={
        owner == "pytorch"
          ? loggedIn
            ? "Click to update Dr. CI.  This might take a while."
            : "You must be logged in to update Dr. CI"
          : "Dr. CI is only available for pytorch org PRs"
      }
    >
      <span>
        <Button
          variant="contained"
          disableElevation
          disabled={
            !loggedIn || buttonState != "clickable" || owner != "pytorch"
          }
          onClick={() => {
            setButtonState("loading");
          }}
        >
          {buttonState == "loading" && (
            <CircularProgress
              size={20}
              sx={{
                color: "primary",
                position: "absolute",
                top: "50%",
                left: "50%",
                marginTop: "-10px",
                marginLeft: "-10px",
              }}
            />
          )}
          {buttonState == "rateLimited"
            ? "Exceeded Rate Limit"
            : buttonState == "failed"
            ? "Failed to Update"
            : "Update Dr. CI"}
        </Button>
      </span>
    </Tooltip>
  );
}

function Page() {
  const router = useRouter();

  const { repoOwner, repoName, prNumber, sha } = router.query;
  const useCH = useCHContext().useCH;

  let swrKey;
  if (prNumber !== undefined) {
    swrKey = `/api/${repoOwner}/${repoName}/pull/${router.query.prNumber}?use_ch=${useCH}`;
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
