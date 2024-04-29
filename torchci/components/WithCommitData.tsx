/* Wrapper component for fetching commit data */

import useSWR from "swr";
import { CommitData, JobData } from "lib/types";
import { fetcher } from "../lib/GeneralUtils";

export function WithCommitData({
  sha,
  repoOwner,
  repoName,
  children,
}: {
  sha: string;
  repoOwner: string;
  repoName: string;
  children: (commitInfo: {
    commit: CommitData;
    jobs: JobData[];
  }) => JSX.Element;
}): JSX.Element {
  const { data, error } = useSWR(
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
    return <div>Error occurred</div>;
  }

  if (data === undefined) {
    return <div>Loading...</div>;
  }

  return children(data);
}
