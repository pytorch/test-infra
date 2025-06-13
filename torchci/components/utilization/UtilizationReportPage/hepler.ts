import dayjs from "dayjs";
import { fetcher } from "lib/GeneralUtils";
import { ListUtilizationReportAPIResponse } from "lib/utilization/types";
import useSWR from "swr";

export function useUtilReports(params: any): {
  list: any[];
  metaError: any;
  min_time?: any;
  max_time?: any;
} {
  const nowDateString = dayjs.utc().format("YYYY-MM-DD");
  const queryParams = new URLSearchParams({
    repo: params?.repo || "pytorch/pytorch",
    group_by: params?.group_by || "workflow_name",
    granularity: params?.granularity || "day",
    start_time: params?.start_time || nowDateString,
    end_time: params?.end_time || nowDateString,
    parent_group: params?.parent_group || "",
  });

  const url = `/api/list_util_reports/${
    params?.group_by || "workflow_name"
  }?${queryParams.toString()}`;

  const { data, error } = useSWR<ListUtilizationReportAPIResponse>(
    url,
    fetcher
  );

  if (error != null) {
    return {
      list: [],
      metaError: "Error occured while fetching util metadata",
    };
  }

  if (data == null) {
    return { list: [], metaError: "Loading..." };
  }

  if (data.metadata_list == null) {
    return { list: [], metaError: "No metadata list found" };
  }
  return {
    list: data.metadata_list,
    min_time: data.min_time
      ? dayjs.utc(data.min_time).format("YYYY-MM-DD")
      : null,
    max_time: data.max_time
      ? dayjs.utc(data.max_time).format("YYYY-MM-DD")
      : null,
    metaError: null,
  };
}

export function objectToQueryString(
  obj: Record<string, any>,
  excludeKeys: string[] = []
): string {
  const excludeSet = new Set(excludeKeys);
  return new URLSearchParams(
    Object.entries(obj).filter(
      ([key, value]) =>
        !excludeSet.has(key) && value !== undefined && value !== null
    )
  ).toString();
}
