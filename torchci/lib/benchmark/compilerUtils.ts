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
      granularity_bucket: bucket,
      workflow_id: workflowId,
      suite: suite,
      compiler: compiler,
      passrate: p,
      pass_count: pc,
      total_count: tc,
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
      granularity_bucket: bucket,
      workflow_id: workflowId,
      suite: suite,
      compiler: compiler,
      dynamo_peak_mem: m.toFixed(SCALE),
    });
  });

  return returnedMemory;
}

// Generate extra entries for reporting purposes
export function augmentData(data: CompilerPerformanceData[]) {
  if (data === undefined) return data;
  const groups: { [key: string]: { [key: string]: Set<string> } } = {
    dynamic: {
      // NB: Not all of these actually exercise dynamic shapes,
      // so our numbers may be over-inflated.  Threats to validity
      // listed below.  Note that in all cases they are run with
      // dynamic batch size, so you are at least getting some
      // information that way.
      torchbench: new Set([
        // _generate variants are good; they do E2E autoregressive
        // generation and will induce varying context length.
        "cm3leon_generate",
        "nanogpt",
        "hf_T5_generate",
        "nanogpt",
        // detection models are ok-ish; the good news is they call
        // nonzero internally and exercise dynamic shapes that way,
        // the bad news is we may not run enough iterations with
        // varying data to get varying numbers of bounding boxes.
        "detectron2_fcos_r_50_fpn",
        "vision_maskrcnn",
        // this recommendation model internally uses sparse tensors
        // but once again it's not clear that dynamic shapes is exercised
        // on this sparsity
        "dlrm",
        // these language models are only running a single next
        // word prediction, we're NOT testing dynamic sequence length
        // performance
        "llama",
        "BERT_pytorch",
        "hf_T5",
        // the GNN benchmarks only one run one batch so you
        // aren't actually triggering dynamism (and we didn't
        // explicitly mark something as dynamic)
        "basic_gnn_edgecnn",
        "basic_gnn_gcn",
        "basic_gnn_gin",
        "basic_gnn_sage",
      ]),
      huggingface: new Set([]),
    },
    blueberries: {
      torchbench: new Set([
        "nanogpt",
        "llama",
        "llama_v2_7b_16h",
        "sam",
        "sam_fast",
        "clip",
        "stable_diffusion_text_encoder",
        "hf_Whisper",
      ]),
    },
  };

  function GenerateGroup(data: CompilerPerformanceData[], n: string) {
    const l = groups[n];
    return data
      .filter((e: CompilerPerformanceData) => {
        return e.suite in l && l[e.suite].has(e.name);
      })
      .map((e) => {
        return { ...e, suite: n };
      });
  }

  return ([] as CompilerPerformanceData[]).concat(
    data,
    ...Object.keys(groups).map((n) => GenerateGroup(data, n))
  );
}

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
