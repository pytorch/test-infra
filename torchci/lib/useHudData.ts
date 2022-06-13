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
  const { data } = useSWR(formatHudUrlForFetch("api/hud", params), fetcher, {
    refreshInterval: 60 * 1000, // refresh every minute
    // Refresh even when the user isn't looking, so that switching to the tab
    // will always have fresh info.
    refreshWhenHidden: true,
  });

  // Add job name info back into the data (it was stripped out as technically it's redundant)
  if (data === undefined) {
    return data;
  }
  data.shaGrid.forEach((row: RowData) => {
    row.jobs.forEach((job: JobData, index: number) => {
      job.name = data.jobNames[index];
    });
  });

  return data;
}
