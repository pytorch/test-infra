import { SCALE } from "components/benchmark/compilers/common";
import { TritonBenchPerformanceData } from "lib/types";

export function computeCompileTime(data: TritonBenchPerformanceData[]) {
  const compTime: { [k: string]: any } = {};
  const returnedCompTime: any[] = [];
  data.forEach((record: TritonBenchPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const operator = record.operator;
    const backend = record.backend;
    const compileLatency = record.metric_value;

    const key = `${bucket}+${workflowId}+${operator}+${suite}+${backend}`;
    if (!(key in compTime)) {
      compTime[key] = [];
    }

    if (compileLatency !== 0.0) {
      compTime[key].push(compileLatency);
    }
  });

  Object.keys(compTime).forEach((key: string) => {
      const l = compTime[key].length;
      const m =
        l !== 0
          ? compTime[key].reduce((total: number, v: number) => total + v, 0) / l
          : 0;

      const [bucket, workflowId, operator, suite, backend] = key.split("+");
      returnedCompTime.push({
        granularity_bucket: bucket,
        workflow_id: workflowId,
        operator: operator,
        suite: suite,
        backend: backend,
        compilation_latency: m.toFixed(SCALE),
      });
  });

  return returnedCompTime;
}
