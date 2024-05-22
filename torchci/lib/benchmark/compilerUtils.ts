import {
  SCALE,
  COMPILER_NAMES_TO_DISPLAY_NAMES,
  BLOCKLIST_COMPILERS,
  PASSING_ACCURACY,
} from "components/benchmark/compilers/common";
import { CompilerPerformanceData } from "lib/types";

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

    if (!(bucket in models)) {
      models[bucket] = {};
    }

    if (!(workflowId in models[bucket])) {
      models[bucket][workflowId] = {};
    }

    if (!(suite in models[bucket][workflowId])) {
      models[bucket][workflowId][suite] = {};
    }

    if (!(compiler in models[bucket][workflowId][suite])) {
      models[bucket][workflowId][suite][compiler] = new Set<string>();
    }

    if (PASSING_ACCURACY.includes(accuracy)) {
      models[bucket][workflowId][suite][compiler].add(model);
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
  return passingModels[bucket][workflowId][suite][compiler].has(model);
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

    if (!(bucket in totalCount)) {
      totalCount[bucket] = {};
      passCount[bucket] = {};
    }

    if (!(workflowId in totalCount[bucket])) {
      totalCount[bucket][workflowId] = {};
      passCount[bucket][workflowId] = {};
    }

    if (!(suite in totalCount[bucket][workflowId])) {
      totalCount[bucket][workflowId][suite] = {};
      passCount[bucket][workflowId][suite] = {};
    }

    if (!(compiler in totalCount[bucket][workflowId][suite])) {
      totalCount[bucket][workflowId][suite][compiler] = 0;
      passCount[bucket][workflowId][suite][compiler] = 0;
    }

    // If the model pass accuracy check but fails the performance benchmark with an
    // 0 speedup, it should be counted as a failure. However, `pass_due_to_skip` is
    // an exception and it's ok to have 0 speedup there
    if (
      (isPass(bucket, workflowId, suite, compiler, model, passingModels) &&
        record.speedup !== 0.0) ||
      accuracy === "pass_due_to_skip"
    ) {
      passCount[bucket][workflowId][suite][compiler] += 1;
    }

    totalCount[bucket][workflowId][suite][compiler] += 1;
  });

  Object.keys(totalCount).forEach((bucket: string) => {
    Object.keys(totalCount[bucket]).forEach((workflowId: string) => {
      Object.keys(totalCount[bucket][workflowId]).forEach((suite: string) => {
        Object.keys(totalCount[bucket][workflowId][suite]).forEach(
          (compiler: string) => {
            const pc = passCount[bucket][workflowId][suite][compiler];
            const tc = totalCount[bucket][workflowId][suite][compiler];
            const p = pc / tc;

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
          }
        );
      });
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

    if (!(bucket in speedup)) {
      speedup[bucket] = {};
    }

    if (!(workflowId in speedup[bucket])) {
      speedup[bucket][workflowId] = {};
    }

    if (!(suite in speedup[bucket][workflowId])) {
      speedup[bucket][workflowId][suite] = {};
    }

    if (!(compiler in speedup[bucket][workflowId][suite])) {
      speedup[bucket][workflowId][suite][compiler] = [];
    }

    if (
      isPass(bucket, workflowId, suite, compiler, model, passingModels) &&
      record.speedup !== 0.0
    ) {
      speedup[bucket][workflowId][suite][compiler].push(record.speedup);
    }
  });

  Object.keys(speedup).forEach((bucket: string) => {
    Object.keys(speedup[bucket]).forEach((workflowId: string) => {
      Object.keys(speedup[bucket][workflowId]).forEach((suite: string) => {
        Object.keys(speedup[bucket][workflowId][suite]).forEach(
          (compiler: string) => {
            const gm = geomean(speedup[bucket][workflowId][suite][compiler]);

            returnedGeomean.push({
              granularity_bucket: bucket,
              workflow_id: workflowId,
              suite: suite,
              compiler: compiler,
              geomean: gm,
            });
          }
        );
      });
    });
  });

  return returnedGeomean;
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

    if (!(bucket in compTime)) {
      compTime[bucket] = {};
    }

    if (!(workflowId in compTime[bucket])) {
      compTime[bucket][workflowId] = {};
    }

    if (!(suite in compTime[bucket][workflowId])) {
      compTime[bucket][workflowId][suite] = {};
    }

    if (!(compiler in compTime[bucket][workflowId][suite])) {
      compTime[bucket][workflowId][suite][compiler] = [];
    }

    if (
      isPass(bucket, workflowId, suite, compiler, model, passingModels) &&
      compLatency !== 0.0
    ) {
      compTime[bucket][workflowId][suite][compiler].push(compLatency);
    }
  });

  Object.keys(compTime).forEach((bucket: string) => {
    Object.keys(compTime[bucket]).forEach((workflowId: string) => {
      Object.keys(compTime[bucket][workflowId]).forEach((suite: string) => {
        Object.keys(compTime[bucket][workflowId][suite]).forEach(
          (compiler: string) => {
            const l = compTime[bucket][workflowId][suite][compiler].length;
            const m =
              compTime[bucket][workflowId][suite][compiler].reduce(
                (total: number, v: number) => total + v,
                0
              ) / l;

            returnedCompTime.push({
              granularity_bucket: bucket,
              workflow_id: workflowId,
              suite: suite,
              compiler: compiler,
              compilation_latency: m.toFixed(SCALE),
            });
          }
        );
      });
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

    if (!(bucket in memory)) {
      memory[bucket] = {};
    }

    if (!(workflowId in memory[bucket])) {
      memory[bucket][workflowId] = {};
    }

    if (!(suite in memory[bucket][workflowId])) {
      memory[bucket][workflowId][suite] = {};
    }

    if (!(compiler in memory[bucket][workflowId][suite])) {
      memory[bucket][workflowId][suite][compiler] = [];
    }

    if (
      isPass(bucket, workflowId, suite, compiler, model, passingModels) &&
      compRatio !== 0.0
    ) {
      memory[bucket][workflowId][suite][compiler].push(compRatio);
    }
  });

  Object.keys(memory).forEach((bucket: string) => {
    Object.keys(memory[bucket]).forEach((workflowId: string) => {
      Object.keys(memory[bucket][workflowId]).forEach((suite: string) => {
        Object.keys(memory[bucket][workflowId][suite]).forEach(
          (compiler: string) => {
            const l = memory[bucket][workflowId][suite][compiler].length;
            const m =
              memory[bucket][workflowId][suite][compiler].reduce(
                (total: number, v: number) => total + v,
                0
              ) / l;

            returnedMemory.push({
              granularity_bucket: bucket,
              workflow_id: workflowId,
              suite: suite,
              compiler: compiler,
              compression_ratio: m.toFixed(SCALE),
            });
          }
        );
      });
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

    if (!(bucket in memory)) {
      memory[bucket] = {};
    }

    if (!(workflowId in memory[bucket])) {
      memory[bucket][workflowId] = {};
    }

    if (!(suite in memory[bucket][workflowId])) {
      memory[bucket][workflowId][suite] = {};
    }

    if (!(compiler in memory[bucket][workflowId][suite])) {
      memory[bucket][workflowId][suite][compiler] = [];
    }

    if (isPass(bucket, workflowId, suite, compiler, model, passingModels)) {
      memory[bucket][workflowId][suite][compiler].push(dynamoPeakMem);
    }
  });

  Object.keys(memory).forEach((bucket: string) => {
    Object.keys(memory[bucket]).forEach((workflowId: string) => {
      Object.keys(memory[bucket][workflowId]).forEach((suite: string) => {
        Object.keys(memory[bucket][workflowId][suite]).forEach(
          (compiler: string) => {
            const l = memory[bucket][workflowId][suite][compiler].length;
            const m =
              memory[bucket][workflowId][suite][compiler].reduce(
                (total: number, v: number) => total + v,
                0
              ) / l;

            returnedMemory.push({
              granularity_bucket: bucket,
              workflow_id: workflowId,
              suite: suite,
              compiler: compiler,
              dynamo_peak_mem: m.toFixed(SCALE),
            });
          }
        );
      });
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
