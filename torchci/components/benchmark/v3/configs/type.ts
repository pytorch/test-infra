import dayjs, { Dayjs } from "dayjs";
import { TimeRange } from "lib/benchmark/store/benchmark_regression_store";
export type DataRenderOption = {
  type: string;
  object_id: string;
};

export type SidebarConfiguration = {
  customizedDropdown?: {
    type: string;
    object_id: string;
  };
};

// function signature each converter must implement
export type DataParamConverter = (
  timeRange: TimeRange,
  branches: string[],
  commits: string[],
  filters: Record<string, any>
) => any;

export type BenchmarkUIConfig = {
  benchmarkId: string;
  benchmarkName: string;
  initial: {
    benchmarkId: string;
    time: { start: Dayjs; end: Dayjs };
    filters: Record<string, string>;
    lbranch: string;
    rbranch: string;
  };
  sidebar?: SidebarConfiguration;
  dataRender?: DataRenderOption; // either binds a component or a converter function to render data
  required_filter_fields?: readonly string[]; // required filter fields
};

export const getDefaultDataConverter: DataParamConverter = (
  timeRange: TimeRange,
  branches: string[],
  commits: string[],
  filters: Record<string, any>
): any => {
  // todo: add more general handlers for different data sources
  return {
    ...filters,
    branches: branches,
    commits: commits,
    startTime: dayjs.utc(timeRange.start).format("YYYY-MM-DDTHH:mm:ss"),
    stopTime: dayjs.utc(timeRange.end).format("YYYY-MM-DDTHH:mm:ss"),
  };
};
