import dayjs from "dayjs";
import { geomean } from "lib/benchmark/compilerUtils";
import { fetcher } from "lib/GeneralUtils";
import { BranchAndCommit } from "lib/types";
import _ from "lodash";
import useSWR from "swr";
import {
  BranchAndCommitPerfData,
  DEFAULT_ARCH_NAME,
  DEFAULT_BACKEND_NAME,
  DEFAULT_DEVICE_NAME,
  DEFAULT_DTYPE_NAME,
  DEFAULT_MODE_NAME,
  DEFAULT_MODEL_NAME,
  DEFAULT_QPS_NAME,
  EXCLUDED_METRICS,
  HELION_BENCHMARK_NAME,
  HELION_SPEEDUP_FAIL_VALUE,
  LLM_BENCHMARK_CONFIG_QUERY,
  LLM_BENCHMARK_DATA_QUERY,
  LLMsBenchmarkData,
  REPO_TO_BENCHMARKS,
} from "../common";
import { LLMsBenchmarkProps } from "../types/dashboardProps";
import { TORCHAO_BASELINE } from "./aoUtils";

export function useBenchmark(
  queryParams: { [key: string]: any },
  branchAndCommit: BranchAndCommit
) {
  const queryName: string = LLM_BENCHMARK_DATA_QUERY;

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
  let dtypes: any[] = [];
  if (props.dtypeName === DEFAULT_DTYPE_NAME) {
    dtypes = [];
  } else if (props.repoName == "pytorch/ao") {
    if (props.backendName.startsWith("micro-benchmark")) {
      dtypes = [props.dtypeName];
    } else {
      dtypes = [props.dtypeName, TORCHAO_BASELINE];
    }
  } else {
    dtypes = [props.dtypeName];
  }

  const deviceName =
    props.deviceName === DEFAULT_DEVICE_NAME ? "" : props.deviceName;
  const archName = props.archName === DEFAULT_ARCH_NAME ? "" : props.archName;

  let device = "";
  let arch = "";
  if (archName === "") {
    // All the dashboards currently put device and arch into the same field in
    // device (arch) format, i.e. cuda (NVIDIA B200). So, we need to extract
    // the arch name here to use it in the query
    const deviceArchRegex = new RegExp("^(?<device>.+)\\s+\\((?<arch>.+)\\)$");
    const m = deviceName.match(deviceArchRegex);

    device =
      m !== null && m.groups !== undefined ? m.groups.device : deviceName;
    arch = m !== null && m.groups !== undefined ? m.groups.arch : archName;
  } else {
    // If both device and arch are set, we just need to use them as they are
    device = deviceName;
    arch = archName;
  }

  const queryParams = {
    arch: arch,
    device: device,
    mode: props.modeName === DEFAULT_MODE_NAME ? "" : props.modeName,
    dtypes: dtypes,
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
    repos: props.repos,
    requestRate: props.qps === DEFAULT_QPS_NAME ? "" : props.qps,
  };
  return queryParams;
}

export const useBenchmarkPropsData = (queryParams: any) => {
  const queryName = LLM_BENCHMARK_CONFIG_QUERY;
  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;
  return useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every
  });
};

export function useBenchmarkDataForRepos(
  queryName: string,
  queryParamsList: any[]
) {
  const fetchAll = async () =>
    Promise.all(
      queryParamsList.map((queryParam) => {
        const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
          JSON.stringify(queryParam)
        )}`;
        return fetcher(url)
          .then((data: any) => ({ data }))
          .catch((error: any) => ({ error }));
      })
    );
  return useSWR([queryName, queryParamsList], fetchAll, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });
}

export function combineLeftAndRight(
  repoName: string,
  benchmarkName: string,
  lPerfData: BranchAndCommitPerfData,
  rPerfData: BranchAndCommitPerfData
): { [k: string]: any }[] {
  const dataGroupedByModel: { [k: string]: any } = getDataGroupedByModel(
    lPerfData,
    rPerfData
  );

  // process git job level failure rows
  const jobFailureKeySet = processJobLevelFailureRows(
    dataGroupedByModel,
    repoName
  );

  const data: { [k: string]: any }[] = [];
  for (const key of Object.keys(dataGroupedByModel)) {
    if (jobFailureKeySet.has(key)) {
      continue;
    }

    const row = toRowData(dataGroupedByModel, key, repoName, benchmarkName);
    if ("metadata" in row) {
      data.push(row);
    }
  }

  return data;
}

export function computeGeomean(data: LLMsBenchmarkData[], metricName: string) {
  const metricValues: { [key: string]: number[] } = {};
  const representative: { [key: string]: LLMsBenchmarkData } = {};
  const returnedGeomean: LLMsBenchmarkData[] = [];

  data.forEach((r: LLMsBenchmarkData) => {
    if (r.metric !== metricName) {
      return;
    }

    const origins = r.origins.join(",");
    const k = `${r.granularity_bucket}+${r.workflow_id}+${r.job_id}+${r.backend}+${r.dtype}+${origins}+${r.device}+${r.arch}+${r.metric}`;
    if (!(k in metricValues)) {
      metricValues[k] = [];
      representative[k] = r;
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

    const rep = representative[k];

    // Extract only minimal fields needed for labeling to keep payloads small
    const repoTag = (rep as any)?.extra?.["source_repo"] as string | undefined;
    const deviceId = (rep as any)?.metadata_info?.["device_id"] as
      | string
      | undefined;

    returnedGeomean.push({
      granularity_bucket: bucket,
      model: "",
      backend: backend,
      origins: origins.split(","),
      workflow_id: Number(workflowId),
      job_id: Number(jobId),
      metric: `${metric} (geomean)`,
      actual: Number(gm),
      actual_geomean: Number(gm),
      target: 0,
      dtype: dtype,
      device: device,
      arch: arch,
      // Minimal metadata for downstream labeling
      ...(repoTag ? { repoTag } : {}),
      ...(deviceId ? { deviceId } : {}),
    });
  });
  return returnedGeomean;
}

const getDataGroupedByModel = (
  lPerfData: BranchAndCommitPerfData,
  rPerfData: BranchAndCommitPerfData
) => {
  const lCommit = lPerfData.commit;
  const lData = lPerfData.data;
  // and the right (new commit)
  const rCommit = rPerfData.commit;
  const rData = rPerfData.data;

  const dataGroupedByModel: { [k: string]: any } = {};

  // The right (base commit)
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

  return dataGroupedByModel;
};

const toRowData = (
  dataGroupedByModel: { [k: string]: any },
  key: string,
  repoName: string,
  benchmarkName: string
) => {
  const [model, backend, mode, dtype, device, arch, extra] = key.split(";");
  const row: { [k: string]: any } = {
    // Keep the name as as the row ID as DataGrid requires it
    name: `${model} ${backend} (${mode} / ${dtype} / ${device} / ${arch} / ${extra})`,
  };

  for (const metric in dataGroupedByModel[key]) {
    const record = dataGroupedByModel[key][metric];

    const hasL = "l" in record;
    const hasR = "r" in record;

    // Parse extra info once to extract repo, vLLM fields, etc.
    const extraInfo = JSON.parse(extra);

    // Prefer source repo embedded in extra info if present
    const sourceRepo = extraInfo["source_repo"] || repoName;

    if (!("metadata" in row)) {
      row["metadata"] = {
        model: model,
        origins: hasR ? record["r"].origins : [],
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

    // Attach source repo for downstream consumers (summary/links)
    row["sourceRepo"] = sourceRepo;
    row["repo_name"] = sourceRepo;

    if (
      sourceRepo === "vllm-project/vllm" ||
      sourceRepo === "sgl-project/sglang"
    ) {
      // These fields are only available on vLLM benchmark
      row["extra"] = extraInfo;
      row["tensor_parallel_size"] = extraInfo["tensor_parallel_size"];
      row["request_rate"] = extraInfo["request_rate"];
      row["input_len"] = extraInfo["random_input_len"]
        ? extraInfo["random_input_len"]
        : extraInfo["input_len"];
      row["output_len"] = extraInfo["random_output_len"]
        ? extraInfo["random_output_len"]
        : extraInfo["output_len"];
    }

    if (
      repoName === "pytorch/pytorch" &&
      benchmarkName === "TorchCache Benchmark"
    ) {
      row["is_dynamic"] = extraInfo["is_dynamic"];
    }

    if (metric == "FAILURE_REPORT") {
      row[metric] = {
        l: hasL
          ? {
              actual: Number.MAX_SAFE_INTEGER, // indicate the failure on left side
              actual_geomean: Number.MAX_SAFE_INTEGER, // indicate the failure on left side
              target: 0,
            }
          : {
              actual: 0,
              actual_geomean: 0,
              target: 0,
            },
        r: hasR
          ? {
              actual: Number.MAX_SAFE_INTEGER, // indicate the failure on right side
              actual_geomean: Number.MAX_SAFE_INTEGER, // indicate the failure on right side
              target: 0,
            }
          : {
              actual: 0,
              actual_geomean: 0,
              target: 0,
            },
        highlight: hasL && hasR,
      };
    } else {
      row[metric] = {
        l: hasL
          ? {
              actual: record["l"].actual,
              actual_geomean: record["l"].actual_geomean,
              target: record["l"].target,
            }
          : {
              actual: 0,
              actual_geomean: 0,
              target: 0,
            },
        r: hasR
          ? {
              actual: record["r"].actual,
              actual_geomean: record["r"].actual_geomean,
              target: record["r"].target,
            }
          : {
              actual: 0,
              actual_geomean: 0,
              target: 0,
            },
        highlight: hasL && hasR,
      };
    }
  }
  // Post-process Helion speedups after all metrics are populated to avoid order dependence
  if (benchmarkName === HELION_BENCHMARK_NAME) {
    Object.keys(row).forEach((k: string) => {
      if (!k.endsWith("_speedup")) {
        return;
      }
      const accMetric = k.replace(/_speedup$/, "_accuracy");
      const speedupVal = row[k];
      const accVal = row[accMetric];
      if (accVal.l && accVal.l.actual !== 1) {
        speedupVal.l.actual = HELION_SPEEDUP_FAIL_VALUE;
        speedupVal.l.actual_geomean = HELION_SPEEDUP_FAIL_VALUE;
      }
      if (accVal.r && accVal.r.actual !== 1) {
        speedupVal.r.actual = HELION_SPEEDUP_FAIL_VALUE;
        speedupVal.r.actual_geomean = HELION_SPEEDUP_FAIL_VALUE;
      }
    });
  }
  return row;
};

const processJobLevelFailureRows = (
  dataGroupedByModel: { [k: string]: any },
  repoName: string
): Set<string> => {
  // see if a repo need special handling for job level failure
  const config = getJobReportFailureConfigs();
  if (!(repoName in config)) {
    return new Set();
  }

  const repoSpecificConfig: any = config[repoName];
  const jobLevelFailureConfig = repoSpecificConfig["job_level_failure"];

  // find rows that related to the job level failure
  const jobLevelFailureKeys = Object.keys(dataGroupedByModel).filter(
    (key: string) => {
      const identifier = jobLevelFailureConfig["key_name"];
      const val = getGroupKeyItem(key, identifier);
      const record = dataGroupedByModel[key];

      let isJobLevelFailure = false;

      // check if the row is a git job level failure
      if ("FAILURE_REPORT" in record) {
        const failure_record = record["FAILURE_REPORT"];
        const hasrFailure =
          "r" in failure_record && failure_record["r"].metadata_info
            ? failure_record["r"].metadata_info["failure_type"] === "GIT_JOB"
            : false;
        const haslFailure =
          "l" in failure_record && failure_record["l"].metadata_info
            ? failure_record["l"].metadata_info["failure_type"] === "GIT_JOB"
            : false;
        isJobLevelFailure = hasrFailure || haslFailure;
      }

      if (!val) {
        return false;
      }
      if (jobLevelFailureConfig["content"].includes(val) && isJobLevelFailure) {
        return true;
      }
    }
  );

  // process data to add Failure Report
  Object.keys(dataGroupedByModel).forEach((key: string) => {
    if (jobLevelFailureKeys.includes(key)) {
      return;
    }
    jobLevelFailureKeys.forEach((failureKey: string) => {
      // add FAILURE_REPORT related to job level failure in dataGroupedByModel
      if (jobLevelFailureConfig["is_included"](key, failureKey)) {
        dataGroupedByModel[key]["FAILURE_REPORT"] = _.cloneDeep(
          dataGroupedByModel[failureKey]["FAILURE_REPORT"]
        );
      }
    });
  });

  const jobLevelFailureRowSet = new Set(jobLevelFailureKeys);
  return jobLevelFailureRowSet;
};

function getJobReportFailureConfigs() {
  const JobReportFailureConfig: { [key: string]: any } = {
    "pytorch/executorch": {
      job_level_failure: {
        key_name: "device",
        content: [
          "apple_iphone_15",
          "samsung_galaxy_s22",
          "samsung_galaxy_s24",
          "google_pixel_8_pro",
        ],
        is_included: (key: string, failureRowKey: string, field: string) => {
          const model = getGroupKeyItem(key, "model");
          const backend = getGroupKeyItem(key, "backend");
          const device = getGroupKeyItem(key, "device");
          const failure_model = getGroupKeyItem(failureRowKey, "model");
          const failure_backend = getGroupKeyItem(failureRowKey, "backend");
          const failure_device = getGroupKeyItem(failureRowKey, "device");

          // form prefix for device name
          const prefix = failure_device.split("_").join(" ").toLowerCase();

          if (
            model === failure_model &&
            backend === failure_backend &&
            device.toLocaleLowerCase().startsWith(prefix)
          ) {
            return true;
          }
          return false;
        },
      },
    },
  };
  return JobReportFailureConfig;
}

function getGroupKeyItem(key: string, type: string) {
  const [model, backend, mode, dtype, device, arch, extra] = key.split(";");
  switch (type) {
    case "model":
      return model;
    case "backend":
      return backend;
    case "mode":
      return mode;
    case "dtype":
      return dtype;
    case "device":
      return device;
    case "arch":
      return arch;
    case "extra":
      return extra;
    default:
      return "";
  }
}
