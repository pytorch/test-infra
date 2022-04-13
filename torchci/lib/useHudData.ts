import useSWR from "swr";
import {
  formatHudUrlForFetch,
  HudData,
  HudParams,
  JobData,
  RowData,
} from "./types";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export default function useHudData(params: HudParams): HudData | undefined {
  console.log("PARAMS", params);
  const { data } = useSWR(formatHudUrlForFetch("api/hud", params), fetcher, {
    refreshInterval: 60 * 1000, // refresh every minute
    // Refresh even when the user isn't looking, so that switching to the tab
    // will always have fresh info.
    refreshWhenHidden: true,
  });

  const { data: originalPRData } = useSWR(
    formatHudUrlForFetch("api/original_pr_hud", params),
    fetcher,
    {
      refreshInterval: 60 * 1000,
    }
  );
  // Add job name info back into the data (it was stripped out as technically it's redundant)
  if (data === undefined) {
    return data;
  }
  data.shaGrid.forEach((row: RowData) => {
    row.jobs.forEach((job: JobData, index: number) => {
      job.name = data.jobNames[index];
    });
  });

  if (originalPRData !== undefined) {
    // Merge the original PR data into the main data.
    data.shaGrid.forEach((row: RowData) => {
      row.jobs.forEach((job: JobData) => {
        job.originalPrData = originalPRData[job.sha!]?.[job.name!];
      });
    });
  }
  return data;
}
