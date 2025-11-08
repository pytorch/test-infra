import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { BenchmarkUIConfig } from "../../config_book_types";
dayjs.extend(utc);

export const DEFAULT_SINGLE_VIEW_ID = "default-single";

// The initial config for the compiler benchmark regression page
export const DEFAULT_SINGLE_VIEW_BENCHMARK_INITIAL = {
  time: {
    start: dayjs.utc().startOf("day").subtract(7, "day"),
    end: dayjs.utc().endOf("day"),
  },
  filters: {},
  lbranch: "main",
  rbranch: "main",
};

export const DEFAULT_TABLE_METADATA_COLUMNS = [
  {
    field: "branch",
    displayName: "Branch",
  },
  {
    field: "device",
    displayName: "Hardware type",
  },
  {
    field: "arch",
    displayName: "Hardware model",
  },
] as const;

export const defaultSingleBenchmarkUIConfig: BenchmarkUIConfig | any = {
  benchmarkId: DEFAULT_SINGLE_VIEW_ID,
  apiId: DEFAULT_SINGLE_VIEW_ID,
  title: "Default Single View",
  dataBinding: {
    initial: DEFAULT_SINGLE_VIEW_BENCHMARK_INITIAL,
    required_filter_fields: [],
  },
  dataRender: {
    type: "auto",
    renders: [
      {
        type: "AutoBenchmarkSingleDataTable",
        title: "Single Table",
        config: {
          extraMetadata: DEFAULT_TABLE_METADATA_COLUMNS,
        },
      },
    ],
  },
};
