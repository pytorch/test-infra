import { TORCHAO_BASELINE } from "lib/benchmark/llms/aoUtils";
import { DEFAULT_ARCH_NAME, DEFAULT_BACKEND_NAME, DEFAULT_DEVICE_NAME, DEFAULT_DTYPE_NAME, DEFAULT_MODE_NAME, DEFAULT_MODEL_NAME, EXCLUDED_METRICS, REPO_TO_BENCHMARKS } from "./components/common";
import dayjs from "dayjs";


interface LLMsPickerQueryParams {
    stringValueParams: StringItem[];
    arrayValueParams: ArrayItem[];
}

interface StringItem{
    label: string;
    value: string;
}

interface ArrayItem{
    label: string;
    value: string[];
}

export function getDefaultLLMsPickerPramValues(repoName:string){
    return {
        "arch": DEFAULT_ARCH_NAME,
        "device": DEFAULT_DEVICE_NAME,
        "mode": DEFAULT_MODE_NAME,
        "dtypes": DEFAULT_DTYPE_NAME,
        "benchmarks": REPO_TO_BENCHMARKS[repoName],
        "models": [],
        "backends": DEFAULT_BACKEND_NAME,
        "repo": repoName,
    }
}


const modelNames: string[] = [
    DEFAULT_MODEL_NAME,
    ...(_.uniq(data.map((r: any) => r.model)) as string[]),
  ];
  const backendNames: string[] = _.compact([
    DEFAULT_BACKEND_NAME,
    ...(_.uniq(data.map((r: any) => r.backend)) as string[]),
  ]);
  const deviceNames: string[] = [
    DEFAULT_DEVICE_NAME,
    ...(_.uniq(data.map((r: any) => `${r.device} (${r.arch})`)) as string[]),
  ];
  const modeNames: string[] = _.compact([
    DEFAULT_MODE_NAME,
    ...(_.uniq(data.map((r: any) => r.mode)) as string[]),
  ]);
  const dtypeNames: string[] = _.compact([
    DEFAULT_DTYPE_NAME,
    ...(_.uniq(data.map((r: any) => r.dtype)) as string[]),
  ]);
  const metricNames: string[] = _.uniq(data.map((r: any) => r.metric));


function getExperimentNames(excludedMetrics:string[],repoName:string){
    const queryName = "oss_ci_benchmark_names";

    const queryParams = {
      arch: archName === DEFAULT_ARCH_NAME ? "" : archName,
      device: deviceName === DEFAULT_DEVICE_NAME ? "" : deviceName,
      mode: modeName === DEFAULT_MODE_NAME ? "" : modeName,
      dtypes:
        dtypeName === DEFAULT_DTYPE_NAME
          ? []
          : repoName !== "pytorch/ao"
          ? [dtypeName]
          : [dtypeName, TORCHAO_BASELINE],
      excludedMetrics: EXCLUDED_METRICS,
      benchmarks: benchmarkName ? [benchmarkName] : REPO_TO_BENCHMARKS[repoName],
      granularity: granularity,
      models: modelName === DEFAULT_MODEL_NAME ? [] : [modelName],
      backends: backendName === DEFAULT_BACKEND_NAME ? [] : [backendName],
      repo: repoName,
      startTime: dayjs(startTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
      stopTime: dayjs(stopTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    };

    const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
      JSON.stringify(queryParams)
    )}`;

    const { data } = useSWR(url, fetcher, {
      refreshInterval: 60 * 60 * 1000, // refresh every hour
    });
}

/**
 *
 * @param label the parameter
 * @param value
 * @returns
 */
function getStringItemValue(paramName:string,value:string){
    const defaultParamValues = getDefaultLLMsPickerPramValues(repoName);
    // no default name is found
    if(value){
        return value;
    }
    if (defaultParamValues.hasOwnProperty(paramName)){
        return defaultParamValues[paramName as keyof typeof defaultParamValues];
    }
}
