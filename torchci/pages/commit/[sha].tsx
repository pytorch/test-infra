import CommitStatus from "components/CommitStatus";
import { useRouter } from "next/router";
import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export function CommitInfo({ sha }: { sha: string }) {
  const { data: commit, error } = useSWR(`/api/commit/${sha}`, fetcher, {
    refreshInterval: 60 * 1000, // refresh every minute
    // Refresh even when the user isn't looking, so that switching to the tab
    // will always have fresh info.
    refreshWhenHidden: true,
  });

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
  const sha = router.query.sha as string;

  return (
    <div>
      <h1 id="hud-header">
        PyTorch Commit: <code>{sha}</code>
      </h1>
      {sha !== undefined && <CommitInfo sha={sha} />}
    </div>
  );
}
