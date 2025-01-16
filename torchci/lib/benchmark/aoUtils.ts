import { LLMsBenchmarkData } from "components/benchmark/llms/common";
import { BenchmarkData, CompilerPerformanceData } from "lib/types";

export const TORCHAO_REPO = "pytorch/ao";
// TODO (huydhn): Find a better way to abstract this baseline concept, for example,
// this could be dtype noquant for TorchAO, or eager config for inductor
export const TORCHAO_BASELINE = "noquant";
// TODO (huydhn): The following are TorchAO speedup metrics. Check with ao team to
// see if this information could be codified on the benchmark instead of keeping it
// here on the dashboard
const SPEEDUP_METRICS = ["tok/s", "time_ms(avg)", "time_s(avg)", "img_s(avg)"];

// Different speedup metrics
export const AUTOQUANT_COMPILE_SPEEDUP_METRIC_NAME = "speedup";
export const AUTOQUANT_EAGER_SPEEDUP_METRIC_NAME = "eager_speedup";

// TODO (huydhn): Use this function to convert the generic benchmark data to the old
// CompilerPerformanceData format. This is needed until the TorchInductor dashboard
// is migrated to the new format
export function convertToCompilerPerformanceData(data: BenchmarkData[]) {
  const convertData: { [model: string]: CompilerPerformanceData } = {};
  if (data === undefined || data === null) {
    return [];
  }

  data.forEach((r: BenchmarkData) => {
    const k = `${r.granularity_bucket} ${r.model}`;

    if (!(k in convertData)) {
      convertData[k] = {
        abs_latency: 0,
        accuracy: "",
        compilation_latency: 0,
        compiler: "default",
        compression_ratio: 0,
        dynamo_peak_mem: 0,
        eager_peak_mem: 0,
        granularity_bucket: r.granularity_bucket,
        name: r.model,
        speedup: 0,
        suite: r.suite,
        workflow_id: r.workflow_id,
        job_id: r.job_id,
      };
    }

    // Accuracy metric has a string value instead of a number https://github.com/pytorch/pytorch/pull/143611
    if (r.metric === "accuracy") {
      convertData[k][r.metric] = JSON.parse(
        r.extra_info["benchmark_values"]
      )[0];
    } else {
      // @ts-expect-error
      convertData[k][r.metric] = r.value;
    }
  });

  return Object.values(convertData);
}

export function computeSpeedup(
  repoName: string,
  data: LLMsBenchmarkData[],
  speedupMetricName: string,
  useTorchCompile: boolean
) {
  if (repoName !== TORCHAO_REPO) {
    return data;
  }

  const baselineMetrics: { [key: string]: LLMsBenchmarkData } = {};
  data.forEach((r: LLMsBenchmarkData) => {
    if (
      r.dtype !== TORCHAO_BASELINE ||
      r.use_torch_compile !== useTorchCompile
    ) {
      return;
    }

    const k = `${r.workflow_id} ${r.job_id} ${r.model} ${r.metric} ${r.device} ${r.arch}`;
    baselineMetrics[k] = r;
  });

  const withSpeedup: LLMsBenchmarkData[] = [];
  data.forEach((r: LLMsBenchmarkData) => {
    if (
      r.dtype === TORCHAO_BASELINE &&
      r.use_torch_compile === useTorchCompile
    ) {
      return;
    }

    if (SPEEDUP_METRICS.includes(r.metric)) {
      const k = `${r.workflow_id} ${r.job_id} ${r.model} ${r.metric} ${r.device} ${r.arch}`;
      if (
        k in baselineMetrics &&
        baselineMetrics[k].actual !== 0 &&
        r.actual !== 0
      ) {
        const speedup = r.metric.includes("time")
          ? baselineMetrics[k].actual / r.actual
          : r.actual / baselineMetrics[k].actual;

        withSpeedup.push({
          ...r,
          metric: speedupMetricName,
          actual: Number(speedup.toFixed(4)),
          target: 0,
        });
      }
    }

    withSpeedup.push(r);
  });

  return withSpeedup;
}
