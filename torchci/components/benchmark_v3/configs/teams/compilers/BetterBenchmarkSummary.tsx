import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import TrendingDownIcon from "@mui/icons-material/TrendingDown";
import TrendingFlatIcon from "@mui/icons-material/TrendingFlat";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  Divider,
  IconButton,
  Paper,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from "@mui/material";
import { DataGrid, GridColDef, GridPaginationModel } from "@mui/x-data-grid";
import type { AutoComponentProps } from "components/benchmark_v3/configs/utils/autoRegistration";
import LoadingPage from "components/common/LoadingPage";
import type {
  BetterBenchmarkSummaryData,
  RollupStats,
} from "lib/benchmark/api_helper/backend/dataFetchers/queryBuilderUtils/betterBenchmarkSummary";
import {
  useBenchmarkCommittedContext,
  useBenchmarkTimeSeriesData,
} from "lib/benchmark/api_helper/fe/hooks";
import { useMemo, useState } from "react";

type Mover = BetterBenchmarkSummaryData["models"][number];
type MoverTab = "gains" | "losses" | "neutral";

const NEUTRAL_THRESHOLD_PCT = 5;

function moverCategory(value: number): MoverTab {
  if (value >= NEUTRAL_THRESHOLD_PCT) {
    return "gains";
  }
  if (value <= -NEUTRAL_THRESHOLD_PCT) {
    return "losses";
  }
  return "neutral";
}

function moverCounts(source: Mover[]) {
  return source.reduce(
    (counts, row) => {
      counts[moverCategory(row.reductionPct)] += 1;
      return counts;
    },
    { gains: 0, losses: 0, neutral: 0 }
  );
}

function speedupPctToReductionPct(value: number) {
  return (1 - 1 / (1 + value / 100)) * 100;
}

function formatDelta(value: number, digits = 2) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function formatLatency(value: number, signed = false) {
  const prefix = signed && value >= 0.005 ? "+" : "";
  const absolute = Math.abs(value);
  if (absolute >= 1000) {
    return `${prefix}${(value / 1000).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} ms`;
  }
  return `${prefix}${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} µs`;
}

function DeltaValue({
  value,
  large = false,
  speedup = false,
}: {
  value: number;
  large?: boolean;
  speedup?: boolean;
}) {
  const classifiedValue = speedup ? speedupPctToReductionPct(value) : value;
  const neutral = Math.abs(classifiedValue) < NEUTRAL_THRESHOLD_PCT;
  const improving = classifiedValue >= NEUTRAL_THRESHOLD_PCT;
  return (
    <Stack
      direction="row"
      spacing={0.5}
      alignItems="center"
      sx={{
        color: neutral
          ? "text.secondary"
          : improving
          ? "success.main"
          : "error.main",
      }}
    >
      {neutral ? (
        <TrendingFlatIcon fontSize={large ? "large" : "small"} />
      ) : improving ? (
        <TrendingUpIcon fontSize={large ? "large" : "small"} />
      ) : (
        <TrendingDownIcon fontSize={large ? "large" : "small"} />
      )}
      <Typography
        component="span"
        sx={{
          fontSize: large ? { xs: "2.25rem", md: "3rem" } : "inherit",
          fontWeight: large ? 700 : 600,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatDelta(value, large ? 3 : 2)}
      </Typography>
    </Stack>
  );
}

function LatencySavedValue({ value }: { value: number }) {
  return (
    <Typography
      component="span"
      fontWeight={600}
      sx={{
        color:
          value > 0
            ? "success.main"
            : value < 0
            ? "error.main"
            : "text.secondary",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {formatLatency(value, true)}
    </Typography>
  );
}

function SummaryCard({
  title,
  description,
  stats,
  projected = false,
  unavailableReason = "",
  distribution,
}: {
  title: string;
  description: string;
  stats: RollupStats | null;
  projected?: boolean;
  unavailableReason?: string;
  distribution?: ReturnType<typeof moverCounts>;
}) {
  return (
    <Card variant="outlined" sx={{ height: "100%" }}>
      <CardContent>
        <Stack direction="row" justifyContent="space-between" spacing={2}>
          <Box>
            <Stack direction="row" spacing={0.75} alignItems="center">
              <Typography variant="h6" component="h3">
                {title}
              </Typography>
              <Tooltip title={description}>
                <IconButton
                  size="small"
                  aria-label={`How ${title.toLowerCase()} is calculated`}
                >
                  <InfoOutlinedIcon color="action" fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
            {projected && (
              <Typography variant="caption" color="text.secondary">
                Projected end-to-end estimate
              </Typography>
            )}
          </Box>
          <Chip
            size="small"
            variant="outlined"
            label={`n = ${stats?.n ?? 0}`}
          />
        </Stack>
        {stats ? (
          <>
            <Box sx={{ my: 2 }}>
              <Typography variant="overline" color="text.secondary">
                Geometric-mean speedup
              </Typography>
              <DeltaValue value={stats.geomean} large speedup />
              <Typography variant="caption" color="text.secondary">
                Median and mean below are per-item latency changes. Positive is
                faster; negative is slower.
              </Typography>
              {distribution && (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ mt: 0.5 }}
                >
                  {distribution.gains} improved · {distribution.losses}{" "}
                  regressed · {distribution.neutral} neutral
                </Typography>
              )}
            </Box>
            <Divider />
            <Stack
              direction="row"
              spacing={3}
              sx={{ mt: 2 }}
              divider={<Divider orientation="vertical" flexItem />}
            >
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Median latency change
                </Typography>
                <Typography fontWeight={600}>
                  {formatDelta(stats.median, 3)}
                </Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Mean latency change
                </Typography>
                <Typography fontWeight={600}>
                  {formatDelta(stats.mean, 3)}
                </Typography>
              </Box>
            </Stack>
          </>
        ) : (
          <Alert severity="warning" sx={{ mt: 2 }}>
            {unavailableReason ||
              "No exact points are shared by the selected workflows."}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function SectionHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Box sx={{ mb: 1.5 }}>
      <Typography variant="h5" component="h3" fontWeight={650}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {description}
      </Typography>
    </Box>
  );
}

function SuiteBreakdown({
  rows,
}: {
  rows: BetterBenchmarkSummaryData["suites"];
}) {
  const max = Math.max(
    0,
    ...rows.map((row) => Math.abs(row.stats?.geomean ?? 0))
  );
  const domain = Math.max(2, Math.ceil(max));
  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, md: 2.5 } }}>
      <SectionHeader
        title="Performance by suite and mode"
        description={`Each complete model receives equal weight. Bars use a centered, fixed ±${domain}% scale.`}
      />
      {rows.length === 0 ? (
        <Typography color="text.secondary">
          No complete model comparisons.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {rows.map((row) => (
            <Box
              key={row.id}
              sx={{
                display: "grid",
                gridTemplateColumns: {
                  xs: "minmax(125px, 1fr) minmax(150px, auto)",
                  md: "180px minmax(180px, 1fr) 100px 100px 180px",
                },
                gap: 2,
                alignItems: "center",
                px: 1.25,
                py: 1,
                borderRadius: 1,
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <Typography fontWeight={600}>{row.suiteMode}</Typography>
              <Tooltip
                title={
                  row.stats
                    ? `${row.suiteMode}: ${formatDelta(
                        row.stats.geomean,
                        2
                      )} geometric-mean speedup`
                    : `${row.suiteMode}: no complete comparisons`
                }
              >
                <Box
                  role="img"
                  aria-label={
                    row.stats
                      ? `${row.suiteMode} geometric-mean speedup ${formatDelta(
                          row.stats.geomean,
                          2
                        )}`
                      : `${row.suiteMode} has no complete comparisons`
                  }
                  sx={{
                    display: { xs: "none", md: "block" },
                    position: "relative",
                    height: 8,
                    borderRadius: 4,
                    bgcolor: "action.hover",
                    overflow: "hidden",
                  }}
                >
                  <Box
                    sx={{
                      position: "absolute",
                      left: "50%",
                      top: 0,
                      bottom: 0,
                      width: "1px",
                      bgcolor: "text.secondary",
                      opacity: 0.65,
                      zIndex: 1,
                    }}
                  />
                  <Box
                    sx={{
                      position: "absolute",
                      left:
                        row.stats && row.stats.geomean < 0
                          ? `${
                              50 -
                              Math.min(
                                50,
                                (Math.abs(row.stats.geomean) / domain) * 50
                              )
                            }%`
                          : "50%",
                      width: row.stats
                        ? `${Math.min(
                            50,
                            (Math.abs(row.stats.geomean) / domain) * 50
                          )}%`
                        : 0,
                      height: "100%",
                      borderRadius: 4,
                      bgcolor:
                        row.stats == null
                          ? "action.disabled"
                          : Math.abs(
                              speedupPctToReductionPct(row.stats.geomean)
                            ) < NEUTRAL_THRESHOLD_PCT
                          ? "text.disabled"
                          : row.stats.geomean > 0
                          ? "success.main"
                          : "error.main",
                    }}
                  />
                </Box>
              </Tooltip>
              <Box sx={{ display: { xs: "none", md: "block" } }}>
                <Typography variant="caption" color="text.secondary">
                  Median
                </Typography>
                <Typography variant="body2">
                  {row.stats ? formatDelta(row.stats.median, 3) : "n/a"}
                </Typography>
              </Box>
              <Box sx={{ display: { xs: "none", md: "block" } }}>
                <Typography variant="caption" color="text.secondary">
                  Mean
                </Typography>
                <Typography variant="body2">
                  {row.stats ? formatDelta(row.stats.mean, 3) : "n/a"}
                </Typography>
              </Box>
              <Stack
                direction="row"
                spacing={0.75}
                alignItems="center"
                justifySelf="end"
                sx={{ whiteSpace: "nowrap" }}
              >
                {row.stats ? (
                  <DeltaValue value={row.stats.geomean} speedup />
                ) : (
                  <Typography color="text.secondary">n/a</Typography>
                )}
                <Typography variant="caption" color="text.secondary">
                  n={row.stats?.n ?? 0}
                </Typography>
              </Stack>
            </Box>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

const latencyColumn = (
  field: "baseUs" | "headUs" | "deltaUs",
  headerName: string,
  signed = false
): GridColDef =>
  signed
    ? {
        field,
        headerName,
        type: "number",
        display: "flex",
        minWidth: 140,
        renderCell: (params) => (
          <LatencySavedValue value={Number(params.value)} />
        ),
      }
    : {
        field,
        headerName,
        type: "number",
        minWidth: 120,
        valueFormatter: (value) => formatLatency(Number(value)),
      };

const modelColumns: GridColDef[] = [
  {
    field: "name",
    headerName: "Model",
    minWidth: 270,
    flex: 1,
    renderCell: (params) => (
      <Typography noWrap title={params.value as string}>
        {params.value as string}
      </Typography>
    ),
  },
  { field: "suite", headerName: "Suite", minWidth: 115 },
  { field: "mode", headerName: "Mode", minWidth: 100 },
  latencyColumn("baseUs", "Baseline"),
  latencyColumn("headUs", "Candidate"),
  latencyColumn("deltaUs", "Latency saved", true),
  {
    field: "reductionPct",
    headerName: "Projected change",
    type: "number",
    display: "flex",
    minWidth: 160,
    renderCell: (params) => <DeltaValue value={params.value as number} />,
  },
];

const kernelColumns: GridColDef[] = [
  {
    field: "name",
    headerName: "Kernel shape",
    minWidth: 245,
    flex: 1,
    renderCell: (params) => (
      <Typography noWrap title={params.value as string} fontFamily="monospace">
        {params.value as string}
      </Typography>
    ),
  },
  {
    field: "exampleModel",
    headerName: "Example model",
    minWidth: 220,
    flex: 0.8,
  },
  latencyColumn("baseUs", "Baseline"),
  latencyColumn("headUs", "Candidate"),
  latencyColumn("deltaUs", "Latency saved", true),
  {
    field: "reductionPct",
    headerName: "Change",
    type: "number",
    display: "flex",
    minWidth: 130,
    renderHeader: () => (
      <Tooltip title="Kernel latency change from baseline to candidate. Positive values mean latency decreased (faster); negative values mean latency increased (slower).">
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Typography component="span" variant="body2" fontWeight={500}>
            Change
          </Typography>
          <InfoOutlinedIcon color="action" fontSize="small" />
        </Stack>
      </Tooltip>
    ),
    renderCell: (params) => <DeltaValue value={params.value as number} />,
  },
  {
    field: "headGapVsSol",
    headerName: "Gap vs SOL",
    type: "number",
    minWidth: 175,
    renderHeader: () => (
      <Tooltip title="Measured kernel latency divided by the estimated hardware speed-of-light latency. 1× is ideal; lower is better.">
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Typography component="span" variant="body2" fontWeight={500}>
            Gap vs SOL
          </Typography>
          <InfoOutlinedIcon color="action" fontSize="small" />
        </Stack>
      </Tooltip>
    ),
    renderCell: (params) => {
      const baseline = params.row.baseGapVsSol;
      const candidate = params.row.headGapVsSol;
      if (baseline == null || candidate == null) {
        return <Typography color="text.secondary">n/a</Typography>;
      }
      return (
        <Tooltip title="Baseline → candidate">
          <Typography sx={{ fontVariantNumeric: "tabular-nums" }}>
            {baseline.toFixed(2)}× → {candidate.toFixed(2)}×
          </Typography>
        </Tooltip>
      );
    },
  },
];

function MoversTable({
  kind,
  source,
}: {
  kind: "models" | "kernels";
  source: Mover[];
}) {
  const [tab, setTab] = useState<MoverTab>("gains");
  const [paginationModel, setPaginationModel] = useState<GridPaginationModel>({
    pageSize: 10,
    page: 0,
  });
  const counts = useMemo(() => moverCounts(source), [source]);
  const rows = useMemo(
    () =>
      source
        .filter((row) => moverCategory(row.reductionPct) === tab)
        .sort((a, b) => {
          if (tab === "gains") {
            return b.deltaUs - a.deltaUs;
          }
          if (tab === "losses") {
            return a.deltaUs - b.deltaUs;
          }
          return Math.abs(b.reductionPct) - Math.abs(a.reductionPct);
        }),
    [source, tab]
  );

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, md: 2.5 } }}>
      <SectionHeader
        title={kind === "models" ? "Model movers" : "Kernel movers"}
        description={
          kind === "models"
            ? "Projected models ranked by absolute latency impact after occurrence weighting and unchanged extern dilution."
            : "Exact kernel-shape matches ranked by absolute latency impact."
        }
      />
      <Tabs
        aria-label={`${
          kind === "models" ? "Model" : "Kernel"
        } mover categories`}
        value={tab}
        onChange={(_, value: MoverTab) => {
          setTab(value);
          setPaginationModel((current) => ({ ...current, page: 0 }));
        }}
        sx={{ mb: 1 }}
      >
        <Tab
          value="gains"
          label={
            <Tooltip
              title={`Latency reduction of ${NEUTRAL_THRESHOLD_PCT}% or more`}
            >
              <span>Gains ({counts.gains})</span>
            </Tooltip>
          }
        />
        <Tab
          value="losses"
          label={
            <Tooltip
              title={`Latency increase of ${NEUTRAL_THRESHOLD_PCT}% or more`}
            >
              <span>Losses ({counts.losses})</span>
            </Tooltip>
          }
        />
        <Tab
          value="neutral"
          label={
            <Tooltip
              title={`Latency change smaller than ${NEUTRAL_THRESHOLD_PCT}% in either direction`}
            >
              <span>Neutral ({counts.neutral})</span>
            </Tooltip>
          }
        />
      </Tabs>
      <DataGrid
        autoHeight
        density="compact"
        rows={rows}
        columns={kind === "models" ? modelColumns : kernelColumns}
        pageSizeOptions={[10, 25, 50, 100]}
        paginationModel={paginationModel}
        onPaginationModelChange={setPaginationModel}
        localeText={{
          noRowsLabel:
            tab === "gains"
              ? "No improvements above the noise threshold"
              : tab === "losses"
              ? "No regressions above the noise threshold"
              : "No changes within the neutral band",
        }}
        showToolbar
        disableRowSelectionOnClick
        sx={{
          border: 0,
          "& .MuiDataGrid-columnHeaders": { bgcolor: "action.hover" },
        }}
      />
    </Paper>
  );
}

function BetterBenchmarkSummary({
  data,
  repo,
}: {
  data: BetterBenchmarkSummaryData;
  repo: string;
}) {
  const workflowUrl = (workflow: string) =>
    `https://github.com/${repo}/actions/runs/${workflow}`;
  const hasRunQualityWarnings = [
    data.coverage.baselineRun,
    data.coverage.candidateRun,
  ].some((run) =>
    [
      run.failedRepros,
      run.invalidMeasurements,
      run.missingShapeFiles,
      run.unresolvedShapeMetadata,
    ].some((value) => (value ?? 0) > 0)
  );
  const hasUnknownRunQuality =
    !data.coverage.baselineRun.available ||
    !data.coverage.candidateRun.available;

  return (
    <Box sx={{ width: "100%", maxWidth: 1500, mx: "auto", py: 2 }}>
      {data.comparisonUnavailableReason && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {data.comparisonUnavailableReason}
        </Alert>
      )}
      {data.modelUnavailableReason &&
        data.modelUnavailableReason !== data.comparisonUnavailableReason && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {data.modelUnavailableReason}. Kernel results remain comparable.
          </Alert>
        )}
      <Paper
        variant="outlined"
        sx={{
          p: 2,
          mb: 2.5,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 1.25,
        }}
      >
        <Typography variant="subtitle2" color="text.secondary">
          Summary comparison
        </Typography>
        <Chip
          component="a"
          clickable
          href={workflowUrl(data.comparison.leftWorkflow)}
          target="_blank"
          rel="noopener noreferrer"
          label={`Baseline workflow: ${data.comparison.leftWorkflow}`}
        />
        <Typography color="text.secondary" aria-hidden>
          →
        </Typography>
        <Chip
          component="a"
          clickable
          color="primary"
          href={workflowUrl(data.comparison.rightWorkflow)}
          target="_blank"
          rel="noopener noreferrer"
          label={`Candidate workflow: ${data.comparison.rightWorkflow}`}
        />
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="caption" color="text.secondary">
          {data.coverage.matchedKernelPoints.toLocaleString()} matched kernel
          points
          {data.coverage.leftOnlyKernelPoints > 0
            ? ` · ${data.coverage.leftOnlyKernelPoints.toLocaleString()} baseline-only`
            : ""}
          {data.coverage.rightOnlyKernelPoints > 0
            ? ` · ${data.coverage.rightOnlyKernelPoints.toLocaleString()} candidate-only`
            : ""}
          {data.coverage.invalidBaselineKernelPoints > 0
            ? ` · ${data.coverage.invalidBaselineKernelPoints.toLocaleString()} invalid baseline`
            : ""}
          {data.coverage.invalidCandidateKernelPoints > 0
            ? ` · ${data.coverage.invalidCandidateKernelPoints.toLocaleString()} invalid candidate`
            : ""}
          {data.coverage.incompatibleModels > 0
            ? ` · ${data.coverage.incompatibleModels.toLocaleString()} accounting-incompatible models`
            : ""}
          {" · "}
          {data.coverage.includedModels}/{data.coverage.totalModels} paired
          complete models
        </Typography>
      </Paper>
      {hasUnknownRunQuality && (
        <Alert severity="info" sx={{ mb: 2.5 }}>
          Sweep-quality metadata is unavailable for one or both workflows.
        </Alert>
      )}
      {hasRunQualityWarnings && (
        <Alert severity="warning" sx={{ mb: 2.5 }}>
          Partial sweep data detected. Baseline:{" "}
          {data.coverage.baselineRun.failedRepros ?? "unknown"} failed repros,{" "}
          {data.coverage.baselineRun.invalidMeasurements ?? "unknown"} invalid
          measurements,{" "}
          {data.coverage.baselineRun.missingShapeFiles ?? "unknown"} missing
          shape files,{" "}
          {data.coverage.baselineRun.unresolvedShapeMetadata ?? "unknown"}{" "}
          unresolved shape points; candidate:{" "}
          {data.coverage.candidateRun.failedRepros ?? "unknown"} failed repros,{" "}
          {data.coverage.candidateRun.invalidMeasurements ?? "unknown"} invalid
          measurements,{" "}
          {data.coverage.candidateRun.missingShapeFiles ?? "unknown"} missing
          shape files,{" "}
          {data.coverage.candidateRun.unresolvedShapeMetadata ?? "unknown"}{" "}
          unresolved shape points. Metrics include only valid exported points.
        </Alert>
      )}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
          gap: 2.5,
          mb: 2.5,
        }}
      >
        <SummaryCard
          title="Overall projected full-model performance"
          description="Estimates each model's latency using measured kernel performance and how often each kernel occurs. External-operation latency is assumed unchanged. Each model contributes equally to the summary."
          stats={data.model}
          projected
          unavailableReason={data.modelUnavailableReason}
          distribution={moverCounts(data.models)}
        />
        <SummaryCard
          title="Overall kernel performance"
          description="Compares latency for the same kernel pattern and input shape in both runs. Each matched kernel measurement contributes once to the summary."
          stats={data.kernel}
          unavailableReason={data.comparisonUnavailableReason}
          distribution={moverCounts(data.kernels)}
        />
      </Box>

      <Stack spacing={2.5}>
        <Alert severity="info" variant="outlined">
          Changes smaller than {NEUTRAL_THRESHOLD_PCT}% are shown as neutral.
        </Alert>
        <SuiteBreakdown rows={data.suites} />
        <MoversTable kind="models" source={data.models} />
        <MoversTable kind="kernels" source={data.kernels} />
      </Stack>
    </Box>
  );
}

export function AutoBetterBenchmarkSummary({ config }: AutoComponentProps) {
  const ctx = useBenchmarkCommittedContext();
  const leftWorkflow = ctx.lcommit?.workflow_id;
  const rightWorkflow = ctx.rcommit?.workflow_id;
  const ready =
    !!ctx.committedTime?.start &&
    !!ctx.committedTime?.end &&
    leftWorkflow != null &&
    rightWorkflow != null;

  const params = ctx.configHandler.dataBinding.toQueryParams({
    repo: ctx.repo,
    branches: [
      ...new Set([ctx.committedLbranch, ctx.committedRbranch].filter(Boolean)),
    ],
    workflows: [String(leftWorkflow ?? ""), String(rightWorkflow ?? "")],
    benchmarkName: ctx.benchmarkName,
    timeRange: ctx.committedTime,
    filters: ctx.committedFilters,
    maxSampling: ctx.committedMaxSampling,
  });
  const fetcherId = config?.config?.fetcherId ?? ctx.benchmarkId;
  const {
    data: response,
    isLoading,
    error,
  } = useBenchmarkTimeSeriesData(fetcherId, ready ? params : null, [
    "better_summary",
  ]);

  if (!ready) {
    return (
      <Alert severity="info">
        Select both comparison commits to load the performance summary.
      </Alert>
    );
  }
  if (isLoading) {
    return (
      <LoadingPage height={400} content="Loading Better Benchmark summary..." />
    );
  }
  if (error) {
    return <Alert severity="error">{error.message}</Alert>;
  }

  const summary = response?.data?.data?.better_summary as
    | BetterBenchmarkSummaryData
    | undefined;
  if (!summary) {
    return <Alert severity="warning">No summary data found.</Alert>;
  }
  return <BetterBenchmarkSummary data={summary} repo={ctx.repo} />;
}
