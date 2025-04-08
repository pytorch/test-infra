import dayjs from "dayjs";
import { geomean } from "lib/benchmark/compilerUtils";
import { fetcher } from "lib/GeneralUtils";
import { BranchAndCommit } from "lib/types";
import useSWR from "swr";
import {
  BranchAndCommitPerfData,
  DEFAULT_ARCH_NAME,
  DEFAULT_BACKEND_NAME,
  DEFAULT_DEVICE_NAME,
  DEFAULT_DTYPE_NAME,
  DEFAULT_MODE_NAME,
  DEFAULT_MODEL_NAME,
  EXCLUDED_METRICS,
  LLMsBenchmarkData,
  REPO_TO_BENCHMARKS,
} from "../common";
import { LLMsBenchmarkProps } from "../types/dashboardProps";
import { TORCHAO_BASELINE } from "./aoUtils";
import { startsWith } from "lodash";
import JobArtifact from "components/JobArtifact";
import { map } from "d3";

export function useBenchmark(
  queryParams: { [key: string]: any },
  branchAndCommit: BranchAndCommit
) {
  const queryName: string = "oss_ci_benchmark_llms";

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

/**
 * generate query params for benchmark page.
 * @param props LLMsBenchmarkProps
 */
export function getLLMsBenchmarkPropsQueryParameter(props: LLMsBenchmarkProps) {
  const queryParams = {
    arch: props.archName === DEFAULT_ARCH_NAME ? "" : props.archName,
    device: props.deviceName === DEFAULT_DEVICE_NAME ? "" : props.deviceName,
    mode: props.modeName === DEFAULT_MODE_NAME ? "" : props.modeName,
    dtypes:
      props.dtypeName === DEFAULT_DTYPE_NAME
        ? []
        : props.repoName !== "pytorch/ao" // TODO(elainewy): add config to handle repos-specific logics
        ? [props.dtypeName]
        : [props.dtypeName, TORCHAO_BASELINE],
    excludedMetrics: EXCLUDED_METRICS,
    benchmarks: props.benchmarkName
      ? [props.benchmarkName]
      : REPO_TO_BENCHMARKS[props.repoName],
    granularity: props.granularity,
    models: props.modelName === DEFAULT_MODEL_NAME ? [] : [props.modelName],
    backends:
      props.backendName === DEFAULT_BACKEND_NAME ? [] : [props.backendName],
    repo: props.repoName,
    startTime: dayjs(props.startTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: dayjs(props.stopTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
  };
  return queryParams;
}

export const useBenchmarkPropsData = (queryParams: any) => {
  const queryName = "oss_ci_benchmark_names";
  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;
  return useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every
  });
};

export function combineLeftAndRight(
  repoName: string,
  benchmarkName: string,
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
    const mode = record.mode;
    const dtype = record.dtype;
    const device = record.device;
    const arch = record.arch;
    const extra = JSON.stringify(record.extra);
    const metric = record.metric;

    const key = `${model};${backend};${mode};${dtype};${device};${arch};${extra}`;
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
      const mode = record.mode;
      const dtype = record.dtype;
      const device = record.device;
      const arch = record.arch;
      const extra = JSON.stringify(record.extra);
      const metric = record.metric;

      const key = `${model};${backend};${mode};${dtype};${device};${arch};${extra}`;
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
    const [model, backend, mode, dtype, device, arch, extra] = key.split(";");
    const row: { [k: string]: any } = {
      // Keep the name as as the row ID as DataGrid requires it
      name: `${model} ${backend} (${mode} / ${dtype} / ${device} / ${arch} / ${extra})`,
    };

    for (const metric in dataGroupedByModel[key]) {
      const record = dataGroupedByModel[key][metric];

      const hasL = "l" in record;
      const hasR = "r" in record;

      if (!("metadata" in row)) {
        row["metadata"] = {
          model: model,
          origins: hasR? record["r"].origins : [],
          backend: backend,
          mode: mode,
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

      if (mode !== "") {
        row["mode"] = mode;
      }

      if (dtype !== "") {
        row["dtype"] = dtype;
      }

      if (backend !== "") {
        row["backend"] = backend;
      }

      row["device_arch"] = {
        device: device,
        arch: arch,
      };

      if (repoName === "vllm-project/vllm") {
        // These fields are only available on vLLM benchmark
        const extraInfo = JSON.parse(extra);
        // TODO (huydhn): Fix the invalid JSON on vLLM side
        if (
          metric.includes("itl") ||
          metric.includes("tpot") ||
          metric.includes("ttft")
        ) {
          extraInfo["request_rate"] =
            extraInfo["request_rate"] !== ""
              ? extraInfo["request_rate"]
              : "Inf";
        }
        // TODO (huydhn): Fix the passing of tensor_parallel_size to the benchmark
        // script on vLLM side
        if (model.includes("8B")) {
          extraInfo["tensor_parallel_size"] =
            extraInfo["tensor_parallel_size"] !== ""
              ? extraInfo["tensor_parallel_size"]
              : 1;
        } else if (model.includes("70B")) {
          extraInfo["tensor_parallel_size"] =
            extraInfo["tensor_parallel_size"] !== ""
              ? extraInfo["tensor_parallel_size"]
              : 4;
        } else if (model.includes("8x7B")) {
          extraInfo["tensor_parallel_size"] =
            extraInfo["tensor_parallel_size"] !== ""
              ? extraInfo["tensor_parallel_size"]
              : 2;
        }

        row["extra"] = extraInfo;
        row["tensor_parallel_size"] = extraInfo["tensor_parallel_size"];
        row["request_rate"] = extraInfo["request_rate"];
      }

      if (
        repoName === "pytorch/pytorch" &&
        benchmarkName === "TorchCache Benchmark"
      ) {
        const extraInfo = JSON.parse(extra);
        row["is_dynamic"] = extraInfo["is_dynamic"];
      }
      if (metric == "FAILURE_REPORT"){
        row[metric] = {
          l: hasL
            ? {
                actual: record["l"].actual,
                target: record["l"].target,
              }
            : {
                actual: -1, // indicate the failure on left side
                target: 0,
              },
          r: hasR
            ? {
                actual: record["r"].actual,
                target: record["r"].target,
              }
            : {
                actual: -1,// indicate the failure on right side
                target: 0,
              },
          highlight:
            hasL &&
            hasR,
        };
     } else{
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
        highlight:
          hasL &&
          hasR,
      };
    }
    }

    if ("metadata" in row) {
      data.push(row);
    }
  });

  return data;
}

export function computeGeomean(data: LLMsBenchmarkData[], metricName: string) {
  const metricValues: { [key: string]: number[] } = {};
  const returnedGeomean: LLMsBenchmarkData[] = [];

  data.forEach((r: LLMsBenchmarkData) => {
    if (r.metric !== metricName) {
      return;
    }

    const origins = r.origins.join(",");
    const k = `${r.granularity_bucket}+${r.workflow_id}+${r.job_id}+${r.backend}+${r.dtype}+${origins}+${r.device}+${r.arch}+${r.metric}`;
    if (!(k in metricValues)) {
      metricValues[k] = [];
    }

    if (r.actual !== 0) {
      metricValues[k].push(r.actual);
    }
  });

  Object.keys(metricValues).forEach((k: string) => {
    const gm = geomean(metricValues[k]);

    const [
      bucket,
      workflowId,
      jobId,
      backend,
      dtype,
      origins,
      device,
      arch,
      metric,
    ] = k.split("+");
    returnedGeomean.push({
      granularity_bucket: bucket,
      model: "",
      backend: backend,
      origins: origins.split(","),
      workflow_id: Number(workflowId),
      job_id: Number(jobId),
      metric: `${metric} (geomean)`,
      actual: Number(gm),
      target: 0,
      dtype: dtype,
      device: device,
      arch: arch,
    });
  });

  return returnedGeomean;
}

function processDateGroupedByModel(repoName:string, dataGroupedByModel: { [k: string]: any }){
  const {failure_rows, failure_mapping} = mapDevicesForFailureReport(repoName, dataGroupedByModel);

  failure_mapping.forEach((key: string) => {
    const obj =  dataGroupedByModel[key]
    obj["FAILURE_REPORT"] = {
      l: {
      }
    }
  })



}

 function mapDevicesForFailureReport(repo:string, maps: { [k: string]: any }){
  let prefixSet: Set<string> = new Set()
  let failureIndicatorRows: { [k: string]: any } = {}
  let failureMapping = new Set<string>()


  if(!(repo in GIT_JOB_FAILURE_MAPPING_CONFIG)){
    return {
      failure_rows:failureIndicatorRows,
      failure_mapping:failureMapping
    }
  }

  const device_pools = GIT_JOB_FAILURE_MAPPING_CONFIG[repo]["device_pools"]
  const device_names = device_pools.map((d:any) => d.name)



  Object.keys(maps).forEach((key: string) => {
    const [model, backend, mode, dtype, device, arch, extra] = key.split(";");
    const extraInfo = JSON.parse(extra);

    const metrics = maps[key]
    if ("FAILURE_REPORT" in metrics && extraInfo["failure_type"]=='GIT_JOB' && device in device_names){
      if (!(key in failureIndicatorRows)) {
        const record =  metrics["FAILURE_REPORT"]
        const hasLFailure = "l" in record;
        const hasRFailure= "r" in record;
        failureIndicatorRows[key] = {
          "l": hasLFailure,
          "r": hasRFailure
        }
      }
      const prefix = device_pools.find((item:any) => item.name === device).prefix
      const res_key = `${model};${backend};${mode};${dtype};${prefix};`;
      if (!(device in prefixSet)) {
        prefixSet.add(res_key)
      }
    }
  })

 Object.keys(maps).forEach((key: string) => {
  for (const prefix of prefixSet) {
    if (key.startsWith(prefix)) {
      failureMapping.add(key)
    }
  }
})

return {
  failure_rows:failureIndicatorRows,
  failure_mapping:failureMapping
}

}

const GIT_JOB_FAILURE_MAPPING_CONFIG:{ [k: string]: any } = {
  "pytorch/excutorch":{
    "device_pools":[{
      name:"apple_iphone_15",
      prefix: "Apple iPhone 15"
    },
    {
      name:"samsung_galaxy_s22",
      prefix:"Samsung Galaxy S22"
    },
    {
       name: "samsung_galaxy_s24",
       prefix: "Samsung Galaxy S24"
    },
    {
      name: "google_pixel_8_pro",
      prefix: "Google Pixel 8"

    }],
  }
}

function removeFieldsByKey<T extends object, K extends keyof T>(obj: T, keysToRemove: K[]): Omit<T, K> {
  const filteredEntries = Object.entries(obj).filter(([key]) => !keysToRemove.includes(key as K));
  return Object.fromEntries(filteredEntries) as Omit<T, K>;
}
