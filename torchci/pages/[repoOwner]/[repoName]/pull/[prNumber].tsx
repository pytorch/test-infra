import { Stack } from "@mui/material";
import { CommitInfo } from "components/commit/CommitInfo";
import DrCIButton from "components/common/DrCIButton";
import ErrorBoundary from "components/common/ErrorBoundary";
import CrcrPrSection from "components/crcr/CrcrPrSection";
import { greenlightGlyphChar } from "components/greenlight/GreenLightIcon";
import { useSetTitle } from "components/layout/DynamicTitle";
import { fetcher } from "lib/GeneralUtils";
import {
  buildStateBySha,
  normalizeSha,
} from "lib/greenlight/greenlightHudState";
import { useGreenlightPrHistory } from "lib/greenlight/useGreenlightPrHistory";
import { PRData } from "lib/types";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import useSWR from "swr";

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
  // Deduped by SWR against the same read behind the panel in CommitInfo, so the
  // picker and the panel cost one request between them.
  const { data: greenlightRows } = useGreenlightPrHistory(
    repoOwner,
    repoName,
    Number(pr)
  );
  const greenlightBySha = buildStateBySha(greenlightRows);
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
        {prData.shas.map(({ sha, title }) => {
          // A character rather than the svg the rest of these surfaces use: an
          // <option> holds text, and its colour is not reliably styleable, so
          // the colour has to be carried by the glyph. Only shas GreenLight
          // actually reviewed are marked -- there is no fallback to the PR's
          // verdict here, because the whole point of the list is to tell the
          // commits apart.
          const glyph = greenlightGlyphChar(
            greenlightBySha.get(normalizeSha(sha))?.status
          );
          return (
            <option key={sha} value={sha}>
              {`${glyph ? `${glyph} ` : ""}${title} (${sha.substring(0, 6)})`}
            </option>
          );
        })}
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
            isCommitPage={false}
            // From the route, not the commit message: a commit still on a PR
            // branch carries no "Pull Request resolved: #N" line for
            // commit.prNum to be parsed out of.
            prNumber={prNumber ? parseInt(prNumber as string) : null}
          />
        )}
      </ErrorBoundary>
      <ErrorBoundary>
        {prNumber && repoOwner === "pytorch" && repoName === "pytorch" && (
          <CrcrPrSection prNumber={parseInt(prNumber as string)} />
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
