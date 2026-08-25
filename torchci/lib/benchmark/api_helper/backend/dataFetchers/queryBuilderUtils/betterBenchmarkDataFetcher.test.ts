/** @jest-environment node */

import { BetterBenchmarkDashboardConfig } from "components/benchmark_v3/configs/teams/compilers/inductor_kernel_benchmark_config";

import { getBenchmarkDataFetcher } from "../fetchers";
import { buildBetterBenchmarkSummary } from "./betterBenchmarkSummary";

function row(
  workflow_id: number,
  model: string,
  metric: string,
  value: number,
  record_type: "kernel" | "model",
  extra: Record<string, string> = {}
) {
  return {
    workflow_id,
    model,
    metric,
    value,
    extra_key: { record_type, ...extra },
  };
}

describe("buildBetterBenchmarkSummary", () => {
  test("computes shape-aligned kernel and model reductions", () => {
    const data = [
      row(10, "kernel-a", "latency_us", 10, "kernel"),
      row(20, "kernel-a", "latency_us", 5, "kernel"),
      row(10, "kernel-a", "gap_vs_sol", 4, "kernel"),
      row(20, "kernel-a", "gap_vs_sol", 2, "kernel"),
      row(10, "kernel-base-only", "latency_us", 4, "kernel"),
      row(
        10,
        "timm/infer/model-a",
        "projected_model_latency_us",
        100,
        "model",
        {
          suite: "timm",
          source_mode: "infer",
        }
      ),
      row(20, "timm/infer/model-a", "projected_model_latency_us", 80, "model", {
        suite: "timm",
        source_mode: "infer",
      }),
      row(10, "timm/infer/model-a", "model_coverage_ratio", 1, "model"),
      row(10, "hf/train/model-b", "model_coverage_ratio", 0.5, "model"),
    ];

    const summary = buildBetterBenchmarkSummary(data, [10, 20]);

    expect(summary.kernel).toEqual({
      geomean: 100,
      median: 50,
      mean: 50,
      n: 1,
    });
    expect(summary.model).toEqual({
      geomean: 25,
      median: 20,
      mean: 20,
      n: 1,
    });
    expect(summary.models[0]).toEqual(
      expect.objectContaining({ baseUs: 100, headUs: 80, deltaUs: 20 })
    );
    expect(summary.kernels[0]).toEqual(
      expect.objectContaining({
        baseUs: 10,
        headUs: 5,
        deltaUs: 5,
        baseGapVsSol: 4,
        headGapVsSol: 2,
      })
    );
    expect(summary.suites).toEqual([
      expect.objectContaining({
        suiteMode: "timm/infer",
        stats: expect.objectContaining({ geomean: 25, n: 1 }),
      }),
      expect.objectContaining({
        suiteMode: "hf/train",
        stats: null,
        excluded: 1,
      }),
    ]);
    expect(summary.coverage).toEqual({
      matchedKernelPoints: 1,
      leftOnlyKernelPoints: 1,
      rightOnlyKernelPoints: 0,
      invalidBaselineKernelPoints: 0,
      invalidCandidateKernelPoints: 0,
      incompatibleModels: 0,
      includedModels: 1,
      totalModels: 2,
      baselineModels: {
        total: 2,
        included: 0,
        excluded: 2,
        meanCoverage: 0.75,
        exclusionReasons: {},
      },
      candidateModels: {
        total: 0,
        included: 0,
        excluded: 0,
        meanCoverage: 0,
        exclusionReasons: {},
      },
      baselineRun: {
        totalRepros: null,
        failedRepros: null,
        invalidMeasurements: null,
        missingShapeFiles: null,
        unresolvedShapeMetadata: null,
        available: false,
      },
      candidateRun: {
        totalRepros: null,
        failedRepros: null,
        invalidMeasurements: null,
        missingShapeFiles: null,
        unresolvedShapeMetadata: null,
        available: false,
      },
    });
  });

  test("compares a workflow with itself", () => {
    const data = [row(10, "kernel-a", "latency_us", 10, "kernel")];

    const summary = buildBetterBenchmarkSummary(data, [10, 10]);

    expect(summary.kernel).toEqual({
      geomean: 0,
      median: 0,
      mean: 0,
      n: 1,
    });
  });

  test("normalizes legacy and new kernel identities", () => {
    const data = [
      {
        workflow_id: 10,
        model: "pointwise_abcdef123456[resnet18_1234abcd]",
        metric: "latency_us",
        value: 10,
        extra_key: {
          timing_policy: "compiled_us",
        } as Record<string, string>,
      },
      {
        workflow_id: 20,
        model: "pointwise_abcdef123456[1234abcd]",
        metric: "latency_us",
        value: 8,
        extra_key: {
          record_type: "kernel",
          pattern_hash: "abcdef123456",
          shape_hash: "1234abcd",
          timing_policy: "compiled_us",
        } as Record<string, string>,
      },
    ];

    const summary = buildBetterBenchmarkSummary(data, [10, 20]);

    expect(summary.kernel?.median).toBe(20);
    expect(summary.kernels).toHaveLength(1);
  });

  test("rejects legacy compiled timing against new auto timing", () => {
    const data = [
      {
        workflow_id: 10,
        model: "pointwise_abcdef123456[resnet18_1234abcd]",
        metric: "latency_us",
        value: 10,
        extra_key: {},
      },
      row(20, "pointwise_abcdef123456[1234abcd]", "latency_us", 8, "kernel", {
        pattern_hash: "abcdef123456",
        shape_hash: "1234abcd",
        timing_policy: "auto",
      }),
    ];

    const summary = buildBetterBenchmarkSummary(data, [10, 20]);
    expect(summary.kernel).toBeNull();
    expect(summary.comparisonUnavailableReason).toContain(
      "different timing policy"
    );
  });

  test("excludes genai microbenchmarks only from the headline", () => {
    const data = [
      row(10, "timm/infer/model-a", "projected_model_latency_us", 100, "model"),
      row(20, "timm/infer/model-a", "projected_model_latency_us", 80, "model"),
      row(
        10,
        "genai/static/SoftmaxForward",
        "projected_model_latency_us",
        100,
        "model"
      ),
      row(
        20,
        "genai/static/SoftmaxForward",
        "projected_model_latency_us",
        50,
        "model"
      ),
    ];

    const summary = buildBetterBenchmarkSummary(data, [10, 20]);

    expect(summary.model?.n).toBe(1);
    expect(summary.model?.median).toBe(20);
    expect(summary.models).toHaveLength(1);
    expect(summary.suites.map((suite) => suite.suiteMode)).not.toContain(
      "genai/static"
    );
  });

  test("rejects an implicit workflow comparison", () => {
    const data = [row(10, "kernel-a", "latency_us", 10, "kernel")];

    expect(() => buildBetterBenchmarkSummary(data, [])).toThrow(
      "requires explicit left/right workflows"
    );
  });

  test("retains every shard job in a workflow", () => {
    const data = [
      {
        ...row(10, "kernel-a", "latency_us", 10, "kernel"),
        job_id: "base-shard-1",
      },
      {
        ...row(10, "kernel-b", "latency_us", 20, "kernel"),
        job_id: "base-shard-2",
      },
      {
        ...row(20, "kernel-a", "latency_us", 5, "kernel"),
        job_id: "head-shard-1",
      },
      {
        ...row(20, "kernel-b", "latency_us", 10, "kernel"),
        job_id: "head-shard-2",
      },
    ];

    const summary = buildBetterBenchmarkSummary(data, [10, 20]);

    expect(summary.kernel?.n).toBe(2);
    expect(summary.kernel?.median).toBe(50);
  });

  test("uses only the latest run attempt for each workflow", () => {
    const data = [
      { ...row(10, "kernel-a", "latency_us", 10, "kernel"), run_attempt: 1 },
      { ...row(10, "kernel-a", "latency_us", 8, "kernel"), run_attempt: 2 },
      { ...row(20, "kernel-a", "latency_us", 4, "kernel"), run_attempt: 1 },
    ];

    const summary = buildBetterBenchmarkSummary(data, [10, 20]);

    expect(summary.kernel?.median).toBe(50);
  });

  test("rejects incompatible accounting artifacts", () => {
    const data = [
      row(10, "timm/infer/model-a", "projected_model_latency_us", 10, "model", {
        accounting_digest: "left",
      }),
      row(20, "timm/infer/model-a", "projected_model_latency_us", 5, "model", {
        accounting_digest: "right",
      }),
      row(10, "kernel-a", "latency_us", 10, "kernel"),
      row(20, "kernel-a", "latency_us", 5, "kernel"),
    ];

    const summary = buildBetterBenchmarkSummary(data, [10, 20]);
    expect(summary.model).toBeNull();
    expect(summary.kernel?.n).toBe(1);
    expect(summary.modelUnavailableReason).toBe("");
    expect(summary.coverage.incompatibleModels).toBe(1);
  });

  test("allows exact duplicates but rejects conflicting values", () => {
    const exact = [
      row(10, "kernel-a", "latency_us", 10, "kernel"),
      row(10, "kernel-a", "latency_us", 10, "kernel"),
      row(20, "kernel-a", "latency_us", 5, "kernel"),
    ];
    expect(buildBetterBenchmarkSummary(exact, [10, 20]).kernel?.n).toBe(1);

    const conflicting = [
      ...exact,
      row(10, "kernel-a", "latency_us", 11, "kernel"),
    ];
    expect(() => buildBetterBenchmarkSummary(conflicting, [10, 20])).toThrow(
      "Conflicting kernel values"
    );
  });

  test("returns null aggregates when no exact matches exist", () => {
    const data = [
      row(10, "kernel-a", "latency_us", 10, "kernel"),
      row(20, "kernel-b", "latency_us", 10, "kernel"),
    ];

    const summary = buildBetterBenchmarkSummary(data, [10, 20]);

    expect(summary.kernel).toBeNull();
    expect(summary.model).toBeNull();
    expect(summary.kernels).toEqual([]);
  });

  test("returns an empty summary when selected workflows have no rows", () => {
    const summary = buildBetterBenchmarkSummary([], [10, 20]);

    expect(summary.kernel).toBeNull();
    expect(summary.model).toBeNull();
    expect(summary.coverage).toEqual({
      matchedKernelPoints: 0,
      leftOnlyKernelPoints: 0,
      rightOnlyKernelPoints: 0,
      invalidBaselineKernelPoints: 0,
      invalidCandidateKernelPoints: 0,
      incompatibleModels: 0,
      includedModels: 0,
      totalModels: 0,
      baselineModels: {
        total: 0,
        included: 0,
        excluded: 0,
        meanCoverage: 0,
        exclusionReasons: {},
      },
      candidateModels: {
        total: 0,
        included: 0,
        excluded: 0,
        meanCoverage: 0,
        exclusionReasons: {},
      },
      baselineRun: {
        totalRepros: null,
        failedRepros: null,
        invalidMeasurements: null,
        missingShapeFiles: null,
        unresolvedShapeMetadata: null,
        available: false,
      },
      candidateRun: {
        totalRepros: null,
        failedRepros: null,
        invalidMeasurements: null,
        missingShapeFiles: null,
        unresolvedShapeMetadata: null,
        available: false,
      },
    });
  });

  test("surfaces invalid kernels and model exclusion details", () => {
    const data = [
      row(10, "kernel-invalid", "latency_us", 0, "kernel"),
      row(20, "kernel-invalid", "latency_us", Number.NaN, "kernel"),
      row(10, "timm/infer/good", "model_coverage_ratio", 1, "model", {
        included: "true",
      }),
      row(10, "timm/infer/bad", "model_coverage_ratio", 0.5, "model", {
        included: "false",
        exclusion_reasons: "unmatched_kernel,trace_errors",
      }),
    ];

    const summary = buildBetterBenchmarkSummary(data, [10, 20]);

    expect(summary.coverage.invalidBaselineKernelPoints).toBe(1);
    expect(summary.coverage.invalidCandidateKernelPoints).toBe(1);
    expect(summary.coverage.baselineModels).toEqual({
      total: 2,
      included: 1,
      excluded: 1,
      meanCoverage: 0.75,
      exclusionReasons: { unmatched_kernel: 1, trace_errors: 1 },
    });
  });
});

describe("BetterBenchmarkDataFetcher", () => {
  test("preserves full timing precision in ClickHouse", () => {
    const fetcher = getBenchmarkDataFetcher("better_benchmark_summary") as any;

    expect(fetcher.build()).toContain(
      "toFloat64(arrayAvg(o.metric.'benchmark_values')) AS value"
    );
    expect(fetcher.build()).not.toContain(
      "floor(arrayAvg(o.metric.'benchmark_values'), 2)"
    );
  });

  test("returns the standard response envelope", () => {
    const fetcher = getBenchmarkDataFetcher("better_benchmark_summary") as any;
    fetcher.toQueryParams({
      repo: "pytorch/pytorch",
      benchmarkName: "inductor-kernel-benchmark",
      workflows: [10, 20],
    });
    const data = [
      row(10, "kernel-a", "latency_us", 10, "kernel"),
      row(20, "kernel-a", "latency_us", 5, "kernel"),
    ];

    const response = fetcher.applyFormat(data, ["better_summary"]);

    expect(response.total_raw_rows).toBe(2);
    expect(response.time_range.start).toBeNull();
    expect(response.data.better_summary.kernel.n).toBe(1);
  });
});

describe("BetterBenchmarkDashboardConfig", () => {
  test("uses type-aware summary tables instead of the mixed generic table", () => {
    const renderTypes =
      BetterBenchmarkDashboardConfig.dataRender.renders?.map(
        (render) => render.type
      ) ?? [];

    expect(renderTypes).toEqual([
      "AutoBetterBenchmarkSummary",
      "AutoBenchmarkComparisonGithubExternalLink",
    ]);
    expect(BetterBenchmarkDashboardConfig.dataRender.subSectionRenders).toEqual(
      {
        main: {
          filterConstraint: {
            mode: { disableOptions: ["inference"] },
            dtype: { disableOptions: ["unknown"] },
          },
          renders: [],
        },
      }
    );
  });
});
