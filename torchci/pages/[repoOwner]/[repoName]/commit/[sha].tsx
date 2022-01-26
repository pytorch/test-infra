import CommitStatus from "components/CommitStatus";
import { useRouter } from "next/router";
import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export function CommitInfo({
  repoOwner,
  repoName,
  sha,
}: {
  repoOwner: string;
  repoName: string;
  sha: string;
}) {
  const { data: commit, error } = useSWR(
    `/api/${repoOwner}/${repoName}/commit/${sha}`,
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

  return (
    <div>
      <h2>{commit.commitTitle}</h2>
      <CommitStatus commit={commit} />
    </div>
  );
}

export default function Page() {
  const router = useRouter();
  const { sha, repoOwner, repoName } = router.query;

  return (
    <div>
      <h1 id="hud-header">
        PyTorch Commit: <code>{sha}</code>
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
