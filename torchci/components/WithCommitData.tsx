/* Wrapper component for fetching commit data */

import { CommitData, JobData } from "lib/types";
import useSWR from "swr";
import { fetcher } from "../lib/GeneralUtils";
import { useCHContext } from "./UseClickhouseProvider";

export function WithCommitData({
  sha,
  repoOwner,
  repoName,
  children,
}: {
  sha: string;
  repoOwner: string;
  repoName: string;
  children: (_commitInfo: {
    commit: CommitData;
    jobs: JobData[];
  }) => JSX.Element;
}): JSX.Element {
  const { data, error } = useSWR(
    `/api/${repoOwner}/${repoName}/commit/${sha}?use_ch=${
      useCHContext().useCH
    }`,
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
