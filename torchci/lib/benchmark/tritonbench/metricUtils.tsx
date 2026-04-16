import { SCALE } from "components/benchmark/compilers/common";
import { TritonBenchPerformanceData } from "lib/types";

export function computeMetric(data: TritonBenchPerformanceData[]) {
  const metric_dict: { [k: string]: any } = {};
  const returned_metric_dict: any[] = [];
  data.forEach((record: TritonBenchPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const operator = record.operator;
    const backend = record.backend;
    const metric_value = record.metric_value;

    const key = `${bucket}+${workflowId}+${operator}+${suite}+${backend}`;
    if (!(key in metric_dict)) {
      metric_dict[key] = [];
    }

    if (metric_value !== 0.0) {
      metric_dict[key].push(metric_value);
    }
  });

  Object.keys(metric_dict).forEach((key: string) => {
    const l = metric_dict[key].length;
    const m =
      l !== 0
        ? metric_dict[key].reduce((total: number, v: number) => total + v, 0) /
          l
        : 0;

    const [bucket, workflowId, operator, suite, backend] = key.split("+");
    returned_metric_dict.push({
      granularity_bucket: bucket,
      workflow_id: workflowId,
      operator: operator,
      suite: suite,
      backend: backend,
      metric_value: m.toFixed(SCALE),
    });
  });

  return returned_metric_dict;
}
