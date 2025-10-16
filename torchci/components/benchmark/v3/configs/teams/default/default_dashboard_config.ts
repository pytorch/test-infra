import { RenderStaticContent } from "components/benchmark/v3/components/common/RawContentDialog";
import dayjs from "dayjs";

export const DEFAULT_DASHBOARD_ID = "default-dashboard";

export const REQUIRED_COMPLIER_LIST_COMMITS_KEYS = ["mode","dtype","deviceName",] as const;

// The initial config for the compiler benchmark regression page
export const DEFAULT_DASHBOARD_BENCHMARK_INITIAL= {
  benchmarkId: DEFAULT_DASHBOARD_ID,
  time: {
    start: dayjs.utc().startOf("day").subtract(7, "day"),
    end: dayjs.utc().endOf("day"),
  },
  filters: {
    // repo: "pytorch/pytorch",
    // benchmarkName: "compiler"
  },
  lbranch: "main",
  rbranch: "main",
};

export const defaultDashboardBenchmarkUIConfig = {
  benchmarkId: DEFAULT_DASHBOARD_ID,
  apiId: DEFAULT_DASHBOARD_ID,
  title: "Default dashboard",
  dataBinding: {
    initial: DEFAULT_DASHBOARD_BENCHMARK_INITIAL,
    required_filter_fields: [],
  },
  dataRender:{
    type: "auto",
    renders:[
      {
        type: "AutoBenchmarkPairwiseComparisonTable",
        title: "Comparison Table",
        filterByFieldValues:{ },
        config: {
          tableConfig: {
            nameKeys: ["compiler"],
            enableDialog: true
          },
        },
      },
    ]
  }
}
