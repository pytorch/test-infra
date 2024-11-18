import { useCHContext } from "components/UseClickhouseProvider";
import useSWR from "swr";
import {
  formatHudUrlForFetch,
  HudDataAPIResponse,
  HudParams,
  JobData,
  RowData,
} from "./types";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export default function useHudData(params: HudParams): RowData[] | undefined {
  const { useCH } = useCHContext();
  let { data } = useSWR<HudDataAPIResponse>(
    formatHudUrlForFetch("api/hud", { ...params, use_ch: useCH }),
    fetcher,
    {
      refreshInterval: 60 * 1000, // refresh every minute
      // Refresh even when the user isn't looking, so that switching to the tab
      // will always have fresh info.
      refreshWhenHidden: true,
    }
  );

  if (data === undefined) {
    return data;
  }

  // Add job name info back into the data (it was stripped out as technically it's redundant)
  data.shaGrid.forEach((row) => {
    row.jobs.forEach((job: JobData, index: number) => {
      job.name = data?.jobNames[index]; // It's not undefined but tsc is complaining
    });
  });

  const newShaGrid = data.shaGrid.map((row) => {
    let unCondensedRow: RowData = {
      ...row,
      nameToJobs: new Map<string, JobData>(),
    };
    unCondensedRow.nameToJobs =
      row.jobs.reduce((map, obj) => (map.set(obj.name, obj), map), new Map()) ??
      new Map();
    // @ts-ignore - jobs should not be there but is because of the ... during init
    delete unCondensedRow.jobs;
    return unCondensedRow;
  });
  return newShaGrid;
}
