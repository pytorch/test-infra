import { BenchmarkData, CompilerPerformanceData } from "lib/types";

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
