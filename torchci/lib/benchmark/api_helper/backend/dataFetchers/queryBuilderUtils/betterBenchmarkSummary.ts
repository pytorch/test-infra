export type RawBenchmarkRow = {
  workflow_id: string | number;
  run_attempt?: string | number;
  job_id?: string | number;
  model: string;
  metric: string;
  value: number;
  device?: string;
  arch?: string;
  extra_key?: Record<string, string>;
  metadata_info?: Record<string, string>;
};

type Pair = {
  id: string;
  name: string;
  baseUs: number;
  headUs: number;
  reductionPct: number;
  speedup: number;
  suite: string;
  mode: string;
  extra: Record<string, string>;
};

export type RollupStats = {
  geomean: number;
  median: number;
  mean: number;
  n: number;
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function summarize(pairs: Pair[]): RollupStats | null {
  if (pairs.length === 0) {
    return null;
  }
  const reductions = pairs.map((pair) => pair.reductionPct);
  const logSpeedups = pairs.map((pair) => Math.log(pair.speedup));
  return {
    geomean: round(
      (Math.exp(
        logSpeedups.reduce((sum, value) => sum + value, 0) / pairs.length
      ) -
        1) *
        100
    ),
    median: round(median(reductions)),
    mean: round(
      reductions.reduce((sum, value) => sum + value, 0) / reductions.length
    ),
    n: pairs.length,
  };
}

function isGenai(name: string): boolean {
  return name.split("/", 1)[0].toLowerCase() === "genai";
}

function kernelIdentity(row: RawBenchmarkRow): string {
  const patternHash = row.extra_key?.pattern_hash;
  const shapeHash = row.extra_key?.shape_hash;
  if (patternHash && shapeHash) {
    return `${patternHash}/${shapeHash}`;
  }

  // Legacy records used repro_dir[model_shapehash], whereas new records use
  // repro_dir[shapehash]. Normalize both to repro_dir[shapehash].
  const match = row.model.match(/^(.*)\[([^\]]+)\]$/);
  if (!match) {
    return row.model;
  }
  const shape = match[2].split("_").at(-1) ?? match[2];
  const pattern = match[1].split("_").at(-1) ?? "";
  if (/^[0-9a-f]{12}$/i.test(pattern)) {
    return `${pattern}/${shape}`;
  }
  return `${match[1]}[${shape}]`;
}

function selectWorkflowRows(
  rows: RawBenchmarkRow[],
  workflows: string[]
): RawBenchmarkRow[] {
  const selected = new Set(workflows);
  const latestAttempts = new Map<string, number>();
  for (const row of rows) {
    const workflow = String(row.workflow_id);
    if (!selected.has(workflow)) {
      continue;
    }
    const attempt = Number(row.run_attempt ?? 1);
    latestAttempts.set(
      workflow,
      Math.max(latestAttempts.get(workflow) ?? 1, attempt)
    );
  }
  return rows.filter(
    (row) =>
      selected.has(String(row.workflow_id)) &&
      Number(row.run_attempt ?? 1) ===
        latestAttempts.get(String(row.workflow_id))
  );
}

function singleMetadata(
  rows: RawBenchmarkRow[],
  workflow: string,
  read: (_row: RawBenchmarkRow) => string | undefined,
  label: string
): string {
  const values = new Set(
    rows
      .filter((row) => String(row.workflow_id) === workflow)
      .map(read)
      .filter((value): value is string => Boolean(value))
  );
  if (values.size > 1) {
    throw new Error(
      `Workflow ${workflow} has conflicting ${label}: ${[...values].join(", ")}`
    );
  }
  return [...values][0] ?? "";
}

function validateCompatibility(
  rows: RawBenchmarkRow[],
  leftWorkflow: string,
  rightWorkflow: string
): string {
  for (const [read, label, strict] of [
    [(row: RawBenchmarkRow) => row.device, "device", false],
    [(row: RawBenchmarkRow) => row.arch, "architecture", false],
    [
      (row: RawBenchmarkRow) => row.extra_key?.timing_policy,
      "timing policy",
      true,
    ],
  ] as const) {
    const left = singleMetadata(rows, leftWorkflow, read, label);
    const right = singleMetadata(rows, rightWorkflow, read, label);
    if (
      (strict && left !== right) ||
      (!strict && left && right && left !== right)
    ) {
      return `Cannot compare workflows with different ${label}: ${left} vs ${right}`;
    }
  }
  return "";
}

function indexedRows(
  rows: RawBenchmarkRow[],
  workflow: string,
  recordType: "kernel" | "model",
  metric: string
): Map<string, RawBenchmarkRow> {
  const points = new Map<string, RawBenchmarkRow>();
  for (const row of rows) {
    const rowRecordType = row.extra_key?.record_type || "kernel";
    if (
      String(row.workflow_id) !== workflow ||
      row.metric !== metric ||
      rowRecordType !== recordType ||
      !Number.isFinite(Number(row.value)) ||
      Number(row.value) <= 0
    ) {
      continue;
    }
    const id = recordType === "kernel" ? kernelIdentity(row) : row.model;
    const previous = points.get(id);
    if (previous && Number(previous.value) !== Number(row.value)) {
      throw new Error(
        `Conflicting ${recordType} values for workflow ${workflow}: ${id}`
      );
    }
    points.set(id, row);
  }
  return points;
}

function invalidRowCount(
  rows: RawBenchmarkRow[],
  workflow: string,
  recordType: "kernel" | "model",
  metric: string
): number {
  return rows.filter((row) => {
    const rowRecordType = row.extra_key?.record_type || "kernel";
    return (
      String(row.workflow_id) === workflow &&
      row.metric === metric &&
      rowRecordType === recordType &&
      (!Number.isFinite(Number(row.value)) || Number(row.value) <= 0)
    );
  }).length;
}

function pairedRows(
  rows: RawBenchmarkRow[],
  leftWorkflow: string,
  rightWorkflow: string,
  recordType: "kernel" | "model",
  metric: string
): {
  pairs: Pair[];
  leftOnly: number;
  rightOnly: number;
  leftInvalid: number;
  rightInvalid: number;
  incompatible: number;
} {
  const base = indexedRows(rows, leftWorkflow, recordType, metric);
  const head = indexedRows(rows, rightWorkflow, recordType, metric);
  const pairs: Pair[] = [];
  let incompatible = 0;
  for (const [id, baseRow] of base.entries()) {
    const headRow = head.get(id);
    if (!headRow) {
      continue;
    }
    if (recordType === "model") {
      const baseAccounting =
        baseRow.extra_key?.model_accounting_digest ||
        baseRow.extra_key?.accounting_digest ||
        "";
      const headAccounting =
        headRow.extra_key?.model_accounting_digest ||
        headRow.extra_key?.accounting_digest ||
        "";
      if (
        baseAccounting &&
        headAccounting &&
        baseAccounting !== headAccounting
      ) {
        incompatible += 1;
        continue;
      }
    }
    const baseUs = Number(baseRow.value);
    const headUs = Number(headRow.value);
    const reductionPct = (1 - headUs / baseUs) * 100;
    const nameParts = baseRow.model.split("/", 3);
    const suite =
      recordType === "model"
        ? nameParts[0] || "unknown"
        : baseRow.extra_key?.suite || "unknown";
    const mode =
      recordType === "model"
        ? nameParts[1] || "unknown"
        : baseRow.extra_key?.source_mode || "unknown";
    pairs.push({
      id,
      name: baseRow.model,
      baseUs,
      headUs,
      reductionPct,
      speedup: baseUs / headUs,
      suite,
      mode,
      extra: baseRow.extra_key ?? {},
    });
  }
  return {
    pairs,
    leftOnly: [...base.keys()].filter((id) => !head.has(id)).length,
    rightOnly: [...head.keys()].filter((id) => !base.has(id)).length,
    leftInvalid: invalidRowCount(rows, leftWorkflow, recordType, metric),
    rightInvalid: invalidRowCount(rows, rightWorkflow, recordType, metric),
    incompatible,
  };
}

function modelCoverageSummary(rows: RawBenchmarkRow[], workflow: string) {
  const coverageRows = rows.filter(
    (row) =>
      row.metric === "model_coverage_ratio" &&
      row.extra_key?.record_type === "model" &&
      String(row.workflow_id) === workflow &&
      !isGenai(row.model)
  );
  const reasons: Record<string, number> = {};
  let included = 0;
  let coverageTotal = 0;
  for (const row of coverageRows) {
    const value = Number(row.value);
    if (Number.isFinite(value)) {
      coverageTotal += value;
    }
    if (row.extra_key?.included === "true") {
      included += 1;
    }
    for (const reason of (row.extra_key?.exclusion_reasons ?? "")
      .split(",")
      .filter(Boolean)) {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
  }
  return {
    total: coverageRows.length,
    included,
    excluded: coverageRows.length - included,
    meanCoverage:
      coverageRows.length > 0 ? round(coverageTotal / coverageRows.length) : 0,
    exclusionReasons: reasons,
  };
}

function runQualitySummary(rows: RawBenchmarkRow[], workflow: string) {
  const readNumber = (key: string) => {
    const raw = singleMetadata(
      rows,
      workflow,
      (row) => row.extra_key?.[key],
      key
    );
    if (!raw) {
      return null;
    }
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const summary = {
    totalRepros: readNumber("sweep_total_repros"),
    failedRepros: readNumber("sweep_failed_repros"),
    invalidMeasurements: readNumber("sweep_invalid_measurements"),
    missingShapeFiles: readNumber("sweep_missing_shape_files"),
    unresolvedShapeMetadata: readNumber("sweep_unresolved_shape_metadata"),
  };
  return {
    ...summary,
    available: Object.values(summary).some((value) => value !== null),
  };
}

export function buildBetterBenchmarkSummary(
  rawRows: RawBenchmarkRow[],
  workflowIds: Array<string | number>
) {
  if (workflowIds.length !== 2) {
    throw new Error(
      "Better Benchmark summary requires explicit left/right workflows"
    );
  }
  const [leftWorkflow, rightWorkflow] = workflowIds.map(String);
  for (const workflow of [leftWorkflow, rightWorkflow]) {
    if (!/^\d+$/.test(workflow) || Number(workflow) <= 0) {
      throw new Error(`Invalid workflow id: ${workflow}`);
    }
  }

  const rows = selectWorkflowRows(rawRows, [leftWorkflow, rightWorkflow]);
  const comparisonUnavailableReason = validateCompatibility(
    rows,
    leftWorkflow,
    rightWorkflow
  );
  const emptyResult = {
    pairs: [],
    leftOnly: 0,
    rightOnly: 0,
    leftInvalid: 0,
    rightInvalid: 0,
    incompatible: 0,
  };
  const modelUnavailableReason = comparisonUnavailableReason;

  const modelResult = modelUnavailableReason
    ? emptyResult
    : pairedRows(
        rows,
        leftWorkflow,
        rightWorkflow,
        "model",
        "projected_model_latency_us"
      );
  const kernelResult = comparisonUnavailableReason
    ? emptyResult
    : pairedRows(rows, leftWorkflow, rightWorkflow, "kernel", "latency_us");
  const models = modelResult.pairs;
  const realModels = models.filter((model) => !isGenai(model.name));
  const kernels = kernelResult.pairs;
  const baselineKernelGaps = indexedRows(
    rows,
    leftWorkflow,
    "kernel",
    "gap_vs_sol"
  );
  const candidateKernelGaps = indexedRows(
    rows,
    rightWorkflow,
    "kernel",
    "gap_vs_sol"
  );

  const suiteGroups = new Map<string, Pair[]>();
  for (const model of realModels) {
    const key = `${model.suite}/${model.mode}`;
    const group = suiteGroups.get(key) ?? [];
    group.push(model);
    suiteGroups.set(key, group);
  }

  const coverageRows = rows.filter(
    (row) =>
      row.metric === "model_coverage_ratio" &&
      row.extra_key?.record_type === "model"
  );
  const realCoverageRows = coverageRows.filter((row) => !isGenai(row.model));
  const coverageModels = new Set(realCoverageRows.map((row) => row.model));
  const coverageBySuite = new Map<string, Set<string>>();
  for (const row of realCoverageRows) {
    const nameParts = row.model.split("/", 3);
    const suite = row.extra_key?.suite || nameParts[0] || "unknown";
    const mode = row.extra_key?.source_mode || nameParts[1] || "unknown";
    const key = `${suite}/${mode}`;
    const group = coverageBySuite.get(key) ?? new Set<string>();
    group.add(row.model);
    coverageBySuite.set(key, group);
  }

  const toMover = (
    pair: Pair,
    gaps: { baseline: number | null; candidate: number | null } = {
      baseline: null,
      candidate: null,
    }
  ) => ({
    id: pair.id,
    name: pair.name,
    suite: pair.suite,
    mode: pair.mode,
    baseUs: round(pair.baseUs),
    headUs: round(pair.headUs),
    deltaUs: round(pair.baseUs - pair.headUs),
    reductionPct: round(pair.reductionPct),
    speedup: round(pair.speedup),
    patternHash: pair.extra.pattern_hash ?? "",
    shapeHash: pair.extra.shape_hash ?? "",
    exampleModel: pair.extra.example_model ?? "",
    baseGapVsSol: gaps.baseline == null ? null : round(gaps.baseline),
    headGapVsSol: gaps.candidate == null ? null : round(gaps.candidate),
  });

  return {
    comparison: {
      leftWorkflow,
      rightWorkflow,
    },
    comparisonUnavailableReason,
    modelUnavailableReason,
    model: summarize(realModels),
    kernel: summarize(kernels),
    suites: [...new Set([...suiteGroups.keys(), ...coverageBySuite.keys()])]
      .map((suiteMode) => {
        const pairs = suiteGroups.get(suiteMode) ?? [];
        const total = coverageBySuite.get(suiteMode)?.size ?? pairs.length;
        return {
          id: suiteMode,
          suiteMode,
          stats: summarize(pairs),
          total,
          excluded: Math.max(0, total - pairs.length),
        };
      })
      .sort(
        (a, b) =>
          (b.stats?.geomean ?? -Infinity) - (a.stats?.geomean ?? -Infinity)
      ),
    models: realModels.map((pair) => toMover(pair)),
    kernels: kernels.map((pair) =>
      toMover(pair, {
        baseline: baselineKernelGaps.has(pair.id)
          ? Number(baselineKernelGaps.get(pair.id)?.value)
          : null,
        candidate: candidateKernelGaps.has(pair.id)
          ? Number(candidateKernelGaps.get(pair.id)?.value)
          : null,
      })
    ),
    coverage: {
      matchedKernelPoints: kernels.length,
      leftOnlyKernelPoints: kernelResult.leftOnly,
      rightOnlyKernelPoints: kernelResult.rightOnly,
      invalidBaselineKernelPoints: kernelResult.leftInvalid,
      invalidCandidateKernelPoints: kernelResult.rightInvalid,
      incompatibleModels: modelResult.incompatible,
      includedModels: realModels.length,
      totalModels: coverageModels.size || realModels.length,
      baselineModels: modelCoverageSummary(rows, leftWorkflow),
      candidateModels: modelCoverageSummary(rows, rightWorkflow),
      baselineRun: runQualitySummary(rows, leftWorkflow),
      candidateRun: runQualitySummary(rows, rightWorkflow),
    },
  };
}

export type BetterBenchmarkSummaryData = ReturnType<
  typeof buildBetterBenchmarkSummary
>;
