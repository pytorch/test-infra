import {
  BLOCKLIST_COMPILERS,
  COMPILER_NAMES_TO_DISPLAY_NAMES,
  PASSING_ACCURACY,
  SCALE,
} from "components/benchmark/compilers/common";
import { BenchmarkData, CompilerPerformanceData } from "lib/types";

export function getPassingModels(data: CompilerPerformanceData[]) {
  const models: { [k: string]: any } = {};

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const model = record.name;
    const accuracy = record.accuracy;

    // Use clear compiler name to avoid confusion about what they do
    const compiler =
      COMPILER_NAMES_TO_DISPLAY_NAMES[record.compiler] ?? record.compiler;
    if (BLOCKLIST_COMPILERS.includes(compiler)) {
      return;
    }

    const key = `${bucket}+${workflowId}+${suite}+${compiler}`;
    if (!(key in models)) {
      models[key] = new Set<string>();
    }

    if (PASSING_ACCURACY.includes(accuracy) || compiler === "eager") {
      models[key].add(model);
    }
  });

  return models;
}

export function isPass(
  bucket: string,
  workflowId: number,
  suite: string,
  compiler: string,
  model: string,
  passingModels: { [k: string]: any }
) {
  return passingModels[`${bucket}+${workflowId}+${suite}+${compiler}`].has(
    model
  );
}

export function computePassrate(
  data: CompilerPerformanceData[],
  passingModels: { [k: string]: any }
) {
  const totalCount: { [k: string]: any } = {};
  const passCount: { [k: string]: any } = {};
  const passrate: any[] = [];

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const model = record.name;
    const accuracy = record.accuracy;

    // Use clear compiler name to avoid confusion about what they do
    const compiler =
      COMPILER_NAMES_TO_DISPLAY_NAMES[record.compiler] ?? record.compiler;
    if (BLOCKLIST_COMPILERS.includes(compiler)) {
      return;
    }

    const key = `${bucket}+${workflowId}+${suite}+${compiler}`;
    if (!(key in totalCount)) {
      totalCount[key] = 0;
      passCount[key] = 0;
    }

    // If the model pass accuracy check but fails the performance benchmark with an
    // 0 speedup, it should be counted as a failure. However, `pass_due_to_skip` is
    // an exception and it's ok to have 0 speedup there, also `export` is an exception
    // because we only measure its pass rate but not speedup.
    if (
      (isPass(bucket, workflowId, suite, compiler, model, passingModels) &&
        (record.speedup !== 0.0 || compiler === "export")) ||
      accuracy === "pass_due_to_skip"
    ) {
      passCount[key] += 1;
    }

    totalCount[key] += 1;
  });

  Object.keys(totalCount).forEach((key: string) => {
    const pc = passCount[key];
    const tc = totalCount[key];
    const p = pc / tc;

    const [bucket, workflowId, suite, compiler] = key.split("+");
    passrate.push({
      metric: "passrate",
      value: p,
      granularity_bucket: bucket,
      workflow_id: workflowId,
      suite: suite,
      compiler: compiler,
      passrate: p,
      pass_count: pc,
      total_count: tc,
      displayName: `${(p * 100).toFixed(0)}%, ${pc}/${tc}`,
      passrate_display: `${(p * 100).toFixed(0)}%, ${pc}/${tc}`,
    });
  });

  return passrate;
}

export function geomean(data: number[]) {
  if (data.length === 0) {
    return 0.0;
  }

  var gm = 1.0;
  data.forEach((v) => {
    gm *= v;
  });
  return Math.pow(gm, 1.0 / data.length).toFixed(SCALE);
}

export function computeGeomean(
  data: CompilerPerformanceData[],
  passingModels: { [k: string]: any }
) {
  const speedup: { [k: string]: any } = {};
  const returnedGeomean: any[] = [];

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const model = record.name;

    // Use clear compiler name to avoid confusion about what they do
    const compiler =
      COMPILER_NAMES_TO_DISPLAY_NAMES[record.compiler] ?? record.compiler;
    if (BLOCKLIST_COMPILERS.includes(compiler)) {
      return;
    }

    const key = `${bucket}+${workflowId}+${suite}+${compiler}`;
    if (!(key in speedup)) {
      speedup[key] = [];
    }

    if (
      isPass(bucket, workflowId, suite, compiler, model, passingModels) &&
      record.speedup !== 0.0
    ) {
      speedup[key].push(record.speedup);
    }
  });

  Object.keys(speedup).forEach((key: string) => {
    const gm = geomean(speedup[key]);

    const [bucket, workflowId, suite, compiler] = key.split("+");
    returnedGeomean.push({
      metric: "geomean_speedup",
      value: Number(gm),
      granularity_bucket: bucket,
      workflow_id: workflowId,
      suite: suite,
      compiler: compiler,
      geomean: gm,
    });
  });

  return returnedGeomean;
}

export function computeExecutionTime(
  data: CompilerPerformanceData[],
  passingModels: { [k: string]: any }
) {
  const executionTime: { [k: string]: any } = {};
  const returnedExecutionTime: any[] = [];

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const model = record.name;
    const absLatency = record.abs_latency;

    // Use clear compiler name to avoid confusion about what they do
    const compiler =
      COMPILER_NAMES_TO_DISPLAY_NAMES[record.compiler] ?? record.compiler;
    if (BLOCKLIST_COMPILERS.includes(compiler)) {
      return;
    }

    const key = `${bucket}+${workflowId}+${suite}+${compiler}`;
    if (!(key in executionTime)) {
      executionTime[key] = [];
    }

    if (
      isPass(bucket, workflowId, suite, compiler, model, passingModels) &&
      absLatency !== 0.0
    ) {
      executionTime[key].push(absLatency);
    }
  });

  Object.keys(executionTime).forEach((key: string) => {
    const l = executionTime[key].length;
    const m =
      l !== 0
        ? executionTime[key].reduce(
            (total: number, v: number) => total + v,
            0
          ) / l
        : 0;

    const [bucket, workflowId, suite, compiler] = key.split("+");
    returnedExecutionTime.push({
      metric: "execution_time",
      value: Number(m.toFixed(SCALE)),
      granularity_bucket: bucket,
      workflow_id: workflowId,
      suite: suite,
      compiler: compiler,
      abs_latency: m.toFixed(SCALE),
    });
  });

  return returnedExecutionTime;
}

export function computeCompilationTime(
  data: CompilerPerformanceData[],
  passingModels: { [k: string]: any }
) {
  const compTime: { [k: string]: any } = {};
  const returnedCompTime: any[] = [];

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const model = record.name;
    const compLatency = record.compilation_latency;

    // Use clear compiler name to avoid confusion about what they do
    const compiler =
      COMPILER_NAMES_TO_DISPLAY_NAMES[record.compiler] ?? record.compiler;
    if (BLOCKLIST_COMPILERS.includes(compiler)) {
      return;
    }

    const key = `${bucket}+${workflowId}+${suite}+${compiler}`;
    if (!(key in compTime)) {
      compTime[key] = [];
    }

    if (
      isPass(bucket, workflowId, suite, compiler, model, passingModels) &&
      compLatency !== 0.0
    ) {
      compTime[key].push(compLatency);
    }
  });

  Object.keys(compTime).forEach((key: string) => {
    const l = compTime[key].length;
    const m =
      l !== 0
        ? compTime[key].reduce((total: number, v: number) => total + v, 0) / l
        : 0;

    const [bucket, workflowId, suite, compiler] = key.split("+");
    returnedCompTime.push({
      metric: "compilation_latency",
      value: Number(m.toFixed(SCALE)),
      granularity_bucket: bucket,
      workflow_id: workflowId,
      suite: suite,
      compiler: compiler,
      compilation_latency: m.toFixed(SCALE),
    });
  });

  return returnedCompTime;
}

export function computeMemoryCompressionRatio(
  data: CompilerPerformanceData[],
  passingModels: { [k: string]: any }
) {
  const memory: { [k: string]: any } = {};
  const returnedMemory: any[] = [];

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const model = record.name;
    const compRatio = record.compression_ratio;

    // Use clear compiler name to avoid confusion about what they do
    const compiler =
      COMPILER_NAMES_TO_DISPLAY_NAMES[record.compiler] ?? record.compiler;
    if (BLOCKLIST_COMPILERS.includes(compiler)) {
      return;
    }

    const key = `${bucket}+${workflowId}+${suite}+${compiler}`;
    if (!(key in memory)) {
      memory[key] = [];
    }

    if (
      isPass(bucket, workflowId, suite, compiler, model, passingModels) &&
      compRatio !== 0.0
    ) {
      memory[key].push(compRatio);
    }
  });

  Object.keys(memory).forEach((key: string) => {
    const l = memory[key].length;
    const m =
      l !== 0
        ? memory[key].reduce((total: number, v: number) => total + v, 0) / l
        : 0;

    const [bucket, workflowId, suite, compiler] = key.split("+");
    returnedMemory.push({
      metric: "compression_ratio",
      value: Number(m.toFixed(SCALE)),
      granularity_bucket: bucket,
      workflow_id: workflowId,
      suite: suite,
      compiler: compiler,
      compression_ratio: m.toFixed(SCALE),
    });
  });

  return returnedMemory;
}

export function computePeakMemoryUsage(
  data: CompilerPerformanceData[],
  passingModels: { [k: string]: any }
) {
  const memory: { [k: string]: any } = {};
  const returnedMemory: any[] = [];

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const model = record.name;
    // NB: Only need dynamo peak memory usage here to supplement the compression
    // ratio metric
    const dynamoPeakMem = record.dynamo_peak_mem;

    // Use clear compiler name to avoid confusion about what they do
    const compiler =
      COMPILER_NAMES_TO_DISPLAY_NAMES[record.compiler] ?? record.compiler;
    if (BLOCKLIST_COMPILERS.includes(compiler)) {
      return;
    }

    const key = `${bucket}+${workflowId}+${suite}+${compiler}`;
    if (!(key in memory)) {
      memory[key] = [];
    }

    if (isPass(bucket, workflowId, suite, compiler, model, passingModels)) {
      memory[key].push(dynamoPeakMem);
    }
  });

  Object.keys(memory).forEach((key: string) => {
    const l = memory[key].length;
    const m =
      memory[key].reduce((total: number, v: number) => total + v, 0) / l;

    const [bucket, workflowId, suite, compiler] = key.split("+");
    returnedMemory.push({
      metric: "dynamo_peak_mem",
      value: Number(m.toFixed(SCALE)),
      granularity_bucket: bucket,
      workflow_id: workflowId,
      suite: suite,
      compiler: compiler,
      dynamo_peak_mem: m.toFixed(SCALE),
    });
  });

  return returnedMemory;
}

// Use this function to convert the generic benchmark data to the old
// CompilerPerformanceData format. Maybe we can get rid of this once
// we have a new UX for benchmark dashboard 2.0
export function convertToCompilerPerformanceData(data: BenchmarkData[]) {
  const convertData: { [model: string]: CompilerPerformanceData } = {};
  if (data === undefined || data === null) {
    return [];
  }

  const workflowBucket: { [id: number]: string } = {};
  // One different in the new benchmark CI is that the results will be
  // uploaded right away when the benchmark job finishes. This means
  // that jobs in the same workflow could have different timestamp and
  // thus, different granularity bucket. The current dashboard logic
  // doesn't like that, so we will just keep the earliest timestamp here
  data.forEach((r: BenchmarkData) => {
    const id = r.workflow_id;

    if (!(id in workflowBucket)) {
      workflowBucket[id] = r.granularity_bucket;
    }
  });

  data.forEach((r: BenchmarkData) => {
    const k = `${r.workflow_id} ${r.model} ${r.backend}`;

    if (!(k in convertData)) {
      convertData[k] = {
        abs_latency: 0,
        accuracy: "",
        compilation_latency: 0,
        compiler: r.backend as string,
        compression_ratio: 0,
        dynamo_peak_mem: 0,
        eager_peak_mem: 0,
        granularity_bucket: workflowBucket[r.workflow_id],
        name: r.model,
        speedup: 0,
        suite: r.suite,
        workflow_id: r.workflow_id,
        job_id: r.job_id,
        branch: r.branch,
        commit: r.commit,
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
