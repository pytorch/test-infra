import {
  Box,
  Paper,
  Skeleton,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useTheme,
} from "@mui/material";
import ReactECharts from "echarts-for-react";
import {
  bucketSpine,
  CHART_GRANULARITY_OPTIONS,
  ChartBucket,
  chartedReverts,
  ChartGranularity,
  chartPlot,
} from "lib/greenlight/qualityCharts";
import {
  isEmptyWindow,
  NO_DATA_IN_WINDOW,
  revertStats,
} from "lib/greenlight/qualityFigures";
import {
  QUALITY_QUERIES,
  QualityQueryState,
  ShadowMode,
  useQualityQuery,
} from "lib/greenlight/qualityQuery";
import { ReactNode, useMemo } from "react";
import {
  chartElementId,
  countedRevertsMessage,
  QUALITY_CHART_ORDER,
  QUALITY_CHARTS,
  QualityChartKey,
  revertTotalsNote,
} from "./chartConfigs";
import { CHART_PAPER_ELEVATION, chartOption } from "./chartOptions";
import InfoTooltip from "./InfoTooltip";
import { revertRateSub } from "./tileConfigs";

const CHART_HEIGHT = 320;

const SECTION_TITLE = "Trends";

const BUCKETS_NOTE =
  "Each bucket is a UTC day, or an ISO week labelled by its Monday. A shaded " +
  "bucket is one the window covers only in part, usually the first or the " +
  "last; hover it for the span it covers.";

const BUCKET_NOUN: Record<ChartGranularity, string> = {
  day: "days",
  week: "weeks",
};

type QualityQueryKey = keyof typeof QUALITY_QUERIES;

function QualityChart({
  chartKey,
  query,
  spine,
  coverage,
  granularity,
  shadowMode,
}: {
  chartKey: QualityChartKey;
  query: QualityQueryState;
  spine: ChartBucket[];
  coverage: QualityQueryState;
  granularity: ChartGranularity;
  shadowMode: ShadowMode;
}) {
  const chart = QUALITY_CHARTS[chartKey];
  const theme = useTheme();
  const plot = useMemo(
    () =>
      chartPlot(
        spine,
        query.rows,
        granularity,
        chart.source,
        chart.series.map((series) => series.value)
      ),
    [chart, spine, query.rows, granularity]
  );
  const option = useMemo(
    () => chartOption(chart, spine, plot, theme, granularity),
    [chart, spine, plot, theme, granularity]
  );

  const reverts =
    chart.source.query === "reverts" ? revertStats(query.rows) : undefined;
  const totalsNote =
    reverts && revertTotalsNote(chartedReverts(plot), reverts.landApproved);
  const emptyMessage =
    reverts?.landApproved === 0
      ? countedRevertsMessage(revertRateSub(reverts).exclusions)
      : undefined;

  const error =
    coverage.error ??
    query.error ??
    (plot.misaligned
      ? `${QUALITY_QUERIES[chart.source.query]}: none of its rows falls on ` +
        `the charted ${BUCKET_NOUN[granularity]}.`
      : undefined);
  let body: ReactNode;
  if (error !== undefined) {
    body = (
      <Typography variant="body2" color="error.main">
        {error}
      </Typography>
    );
  } else if (coverage.loading || query.loading) {
    body = <Skeleton variant="rectangular" height={CHART_HEIGHT} />;
  } else if (spine.length === 0) {
    body = (
      <Typography variant="body2" color="text.secondary">
        {NO_DATA_IN_WINDOW}
      </Typography>
    );
  } else {
    body = (
      <>
        <ReactECharts
          option={option}
          theme={theme.palette.mode === "dark" ? "dark-hud" : undefined}
          style={{ height: "100%", width: "100%" }}
        />
        {emptyMessage !== undefined && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              px: 10,
              pointerEvents: "none",
            }}
          >
            {emptyMessage}
          </Typography>
        )}
      </>
    );
  }

  return (
    <Paper
      id={chartElementId(chartKey)}
      elevation={CHART_PAPER_ELEVATION}
      sx={{ p: 2 }}
    >
      <Stack direction="row" alignItems="center" spacing={0.5}>
        <Typography variant="subtitle2" color="text.secondary">
          {chart.title}
        </Typography>
        <InfoTooltip
          label={chart.title}
          paragraphs={[
            chart.caveat,
            shadowMode === "shadow" ? chart.shadowCaveat : undefined,
            totalsNote,
          ]}
        />
      </Stack>
      <Box sx={{ height: CHART_HEIGHT, mt: 1, position: "relative" }}>
        {body}
      </Box>
    </Paper>
  );
}

// One full-width chart per open tile, in the tiles' order, all on the one
// bucket spine built from coverage's window.
//
// Each source is read once here and handed to every chart drawn from it, and
// only while one of them is open and the window is not known to be empty:
// while coverage is still loading they fetch alongside it. The reverts chart
// reads the rows the revert tile fetched rather than fetching its own.
export default function QualityCharts({
  openCharts,
  onGranularityChange,
  coverage,
  granularity,
  startTime,
  stopTime,
  shadowMode,
  autoRefresh,
}: {
  openCharts: ReadonlySet<QualityChartKey>;
  onGranularityChange: (_granularity: ChartGranularity) => void;
  coverage: QualityQueryState;
  granularity: ChartGranularity;
  startTime: string;
  stopTime: string;
  shadowMode: ShadowMode;
  autoRefresh: boolean;
}) {
  const spine = useMemo(
    () => bucketSpine(coverage.row, granularity),
    [coverage.row, granularity]
  );
  const windowEmpty = !coverage.loading && isEmptyWindow(coverage.row);
  const reads = (source: QualityQueryKey) =>
    !windowEmpty &&
    QUALITY_CHART_ORDER.some(
      (key) =>
        openCharts.has(key) && QUALITY_CHARTS[key].source.query === source
    );
  const bucketed = (source: QualityQueryKey) => ({
    granularity,
    enabled: reads(source),
  });
  const queries: Record<QualityQueryKey, QualityQueryState> = {
    coverage: useQualityQuery(
      QUALITY_QUERIES.coverage,
      startTime,
      stopTime,
      shadowMode,
      autoRefresh,
      bucketed("coverage")
    ),
    latency: useQualityQuery(
      QUALITY_QUERIES.latency,
      startTime,
      stopTime,
      shadowMode,
      autoRefresh,
      bucketed("latency")
    ),
    mergeAuthority: useQualityQuery(
      QUALITY_QUERIES.mergeAuthority,
      startTime,
      stopTime,
      shadowMode,
      autoRefresh,
      bucketed("mergeAuthority")
    ),
    reverts: useQualityQuery(
      QUALITY_QUERIES.reverts,
      startTime,
      stopTime,
      shadowMode,
      false,
      { passive: true, enabled: reads("reverts") }
    ),
  };

  if (openCharts.size === 0) {
    return null;
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography fontSize="16px" fontWeight="700">
          {SECTION_TITLE}
        </Typography>
        <InfoTooltip label={SECTION_TITLE} paragraphs={[BUCKETS_NOTE]} />
        <ToggleButtonGroup
          exclusive
          size="small"
          value={granularity}
          aria-label="Chart bucket size"
          onChange={(_event, value: ChartGranularity | null) => {
            if (value !== null) {
              onGranularityChange(value);
            }
          }}
        >
          {CHART_GRANULARITY_OPTIONS.map((option) => (
            <ToggleButton key={option.value} value={option.value}>
              {option.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Stack>
      {QUALITY_CHART_ORDER.filter((key) => openCharts.has(key)).map((key) => (
        <QualityChart
          key={key}
          chartKey={key}
          query={queries[QUALITY_CHARTS[key].source.query]}
          spine={spine}
          coverage={coverage}
          granularity={granularity}
          shadowMode={shadowMode}
        />
      ))}
    </Stack>
  );
}
