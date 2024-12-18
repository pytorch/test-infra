import {
  BranchAndCommitPerfData,
  LLMsBenchmarkData,
} from "components/benchmark/llms/common";
import { fetcher } from "lib/GeneralUtils";
import { BranchAndCommit } from "lib/types";
import useSWR from "swr";

export function useBenchmark(
  queryParams: { [key: string]: any },
  branchAndCommit: BranchAndCommit
) {
  const queryCollection = "benchmarks";
  const queryName = "oss_ci_benchmark_llms";

  const queryParamsWithBranchAndCommit: { [key: string]: any } = queryParams;
  (queryParamsWithBranchAndCommit as { [key: string]: any })["branches"] =
    branchAndCommit.branch ? [branchAndCommit.branch] : [];
  (queryParamsWithBranchAndCommit as { [key: string]: any })["commits"] =
    branchAndCommit.commit ? [branchAndCommit.commit] : [];

  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithBranchAndCommit)
  )}`;

  return useSWR(url, fetcher, {
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
    const model = record.model;
    const backend = record.backend;
    const dtype = record.dtype;
    const device = record.device;
    const arch = record.arch;
    const metric = record.metric;

    const key = `${model};${backend};${dtype};${device};${arch}`;
    if (!(key in dataGroupedByModel)) {
      dataGroupedByModel[key] = {};
    }

    if (!(metric in dataGroupedByModel[key])) {
      dataGroupedByModel[key][metric] = {};
    }

    dataGroupedByModel[key][metric] = {
      r: record,
    };
  });

  // Combine with left (base) data
  if (lCommit !== rCommit && lData !== undefined) {
    lData.forEach((record: LLMsBenchmarkData) => {
      const model = record.model;
      const backend = record.backend;
      const dtype = record.dtype;
      const device = record.device;
      const arch = record.arch;
      const metric = record.metric;

      const key = `${model};${backend};${dtype};${device};${arch}`;
      if (!(key in dataGroupedByModel)) {
        dataGroupedByModel[key] = {};
      }

      if (!(metric in dataGroupedByModel[key])) {
        dataGroupedByModel[key][metric] = {};
      }

      dataGroupedByModel[key][metric]["l"] = record;
    });
  }

  // Transform the data into a displayable format
  const data: { [k: string]: any }[] = [];
  Object.keys(dataGroupedByModel).forEach((key: string) => {
    const [model, backend, dtype, device, arch] = key.split(";");
    const row: { [k: string]: any } = {
      // Keep the name as as the row ID as DataGrid requires it
      name: `${model} ${backend} (${dtype} / ${device} / ${arch})`,
    };

    for (const metric in dataGroupedByModel[key]) {
      const record = dataGroupedByModel[key][metric];
      const hasL = "l" in record;
      const hasR = "r" in record;

      if (!("metadata" in row)) {
        row["metadata"] = {
          model: model,
          backend: backend,
          dtype: dtype,
          device: device,
          arch: arch,
          l: hasL ? record["l"]["job_id"] : undefined,
          r: hasR ? record["r"]["job_id"] : undefined,
        };
      } else {
        row["metadata"]["l"] =
          row["metadata"]["l"] ?? (hasL ? record["l"]["job_id"] : undefined);
        row["metadata"]["r"] =
          row["metadata"]["r"] ?? (hasR ? record["r"]["job_id"] : undefined);
      }

      if (backend !== "") {
        row["backend"] = backend;
      }

      row["device_arch"] = {
        device: device,
        arch: arch,
      };

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

  return data;
}
