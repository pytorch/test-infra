import {
  BranchAndCommitPerfData,
  DEFAULT_DEVICE_NAME,
  DEFAULT_DTYPE_NAME,
  DEFAULT_MODEL_NAME,
  LLMsBenchmarkData,
} from "components/benchmark/llms/common";
import { fetcher } from "lib/GeneralUtils";
import { RocksetParam } from "lib/rockset";
import { BranchAndCommit } from "lib/types";
import useSWR from "swr";

export function useBenchmark(
  queryParams: RocksetParam[],
  modelName: string,
  dtypeName: string,
  deviceName: string,
  branchAndCommit: BranchAndCommit,
  getJobId: boolean = false
) {
  const queryCollection = "benchmarks";
  const queryName = "oss_ci_benchmark_llms";

  const queryParamsWithBranchAndCommit: RocksetParam[] = [
    {
      name: "names",
      type: "string",
      value: modelName === DEFAULT_MODEL_NAME ? "" : modelName,
    },
    {
      name: "dtypes",
      type: "string",
      value: dtypeName === DEFAULT_DTYPE_NAME ? "" : dtypeName,
    },
    {
      name: "devices",
      type: "string",
      value: deviceName === DEFAULT_DEVICE_NAME ? "" : deviceName,
    },
    {
      name: "getJobId",
      type: "bool",
      value: getJobId,
    },
    ...queryParams,
  ];

  if (branchAndCommit.branch) {
    queryParamsWithBranchAndCommit.push({
      name: "branches",
      type: "string",
      value: branchAndCommit.branch,
    });
  }

  if (branchAndCommit.commit) {
    queryParamsWithBranchAndCommit.push({
      name: "commits",
      type: "string",
      value: branchAndCommit.commit,
    });
  }

  const lUrl = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithBranchAndCommit)
  )}`;

  return useSWR(lUrl, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });
}

export function combineLeftAndRight(
  lPerfData: BranchAndCommitPerfData,
  rPerfData: BranchAndCommitPerfData
): { [k: string]: any }[] {
  // The left (base commit)
  const lBranch = lPerfData.branch;
  const lCommit = lPerfData.commit;
  const lData = lPerfData.data;
  // and the right (new commit)
  const rBranch = rPerfData.branch;
  const rCommit = rPerfData.commit;
  const rData = rPerfData.data;

  const dataGroupedByModel: { [k: string]: any } = {};
  rData.forEach((record: LLMsBenchmarkData) => {
    const name = record.name;
    const dtype = record.dtype;
    const device = record.device;
    const metric = record.metric;

    if (!(name in dataGroupedByModel)) {
      dataGroupedByModel[name] = {};
    }

    if (!(dtype in dataGroupedByModel[name])) {
      dataGroupedByModel[name][dtype] = {};
    }

    if (!(device in dataGroupedByModel[name][dtype])) {
      dataGroupedByModel[name][dtype][device] = {};
    }

    dataGroupedByModel[name][dtype][device][metric] = {
      r: record,
    };
  });

  // Combine with left (base) data
  if (lCommit !== rCommit && lData !== undefined) {
    lData.forEach((record: LLMsBenchmarkData) => {
      const name = record.name;
      const dtype = record.dtype;
      const device = record.device;
      const metric = record.metric;

      if (!(name in dataGroupedByModel)) {
        dataGroupedByModel[name] = {};
      }

      if (!(dtype in dataGroupedByModel[name])) {
        dataGroupedByModel[name][dtype] = {};
      }

      if (!(device in dataGroupedByModel[name][dtype])) {
        dataGroupedByModel[name][dtype][device] = {};
      }

      if (!(metric in dataGroupedByModel[name][dtype][device])) {
        dataGroupedByModel[name][dtype][device][metric] = {};
      }

      dataGroupedByModel[name][dtype][device][metric]["l"] = record;
    });
  }

  // Transform the data into a displayable format
  const data: { [k: string]: any }[] = [];
  Object.keys(dataGroupedByModel).forEach((name: string) => {
    Object.keys(dataGroupedByModel[name]).forEach((dtype: string) => {
      Object.keys(dataGroupedByModel[name][dtype]).forEach((device: string) => {
        const row: { [k: string]: any } = {
          // Keep the name as as the row ID as DataGrid requires it
          name: `${name} (${dtype} / ${device})`,
        };

        for (const metric in dataGroupedByModel[name][dtype][device]) {
          const record = dataGroupedByModel[name][dtype][device][metric];
          const hasL = "l" in record;
          const hasR = "r" in record;

          if (!("metadata" in row)) {
            row["metadata"] = {
              name: name,
              dtype: dtype,
              device: device,
              l: hasL ? record["l"]["job_id"] : undefined,
              r: hasR ? record["r"]["job_id"] : undefined,
            };
          } else {
            row["metadata"]["l"] =
              row["metadata"]["l"] ??
              (hasL ? record["l"]["job_id"] : undefined);
            row["metadata"]["r"] =
              row["metadata"]["r"] ??
              (hasR ? record["r"]["job_id"] : undefined);
          }

          row[metric] = {
            l: hasL
              ? {
                  actual: record["l"].actual,
                  target: record["l"].target,
                }
              : {
                  actual: 0,
                  target: 0,
                },
            r: hasR
              ? {
                  actual: record["r"].actual,
                  target: record["r"].target,
                }
              : {
                  actual: 0,
                  target: 0,
                },
          };
        }

        data.push(row);
      });
    });
  });

  return data;
}
