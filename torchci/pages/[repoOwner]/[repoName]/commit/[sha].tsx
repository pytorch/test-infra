import { AutorevertBanner } from "components/commit/AutorevertBanner";
import { CommitInfo } from "components/commit/CommitInfo";
import { useSetTitle } from "components/layout/DynamicTitle";
import { useRouter } from "next/router";

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

  useSetTitle(`${repoOwner}/${repoName} sha:${sha}`);

  return (
    <div>
      <h1 id="hud-header">
        {fancyName} Commit: <code>{sha}</code>
      </h1>
      {sha !== undefined && (
        <>
          <AutorevertBanner
            repoOwner={repoOwner as string}
            repoName={repoName as string}
            sha={sha as string}
          />
          <CommitInfo
            repoOwner={repoOwner as string}
            repoName={repoName as string}
            sha={sha as string}
            isCommitPage={true}
          />
        </>
      )}
    </div>
  );
}
