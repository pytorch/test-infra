import { Grid, Skeleton, Stack, Typography } from "@mui/material";
import { ScalarPanelWithValue } from "components/metrics/panels/ScalarPanel";
import CiDurationsPanel from "components/metrics/vllm/CiDurationsPanel";
import MergesPanel from "components/metrics/vllm/MergesPanel";
import dayjs from "dayjs";
import { useDarkMode } from "lib/DarkModeContext";
import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import _ from "lodash";
import { useState } from "react";
import { TimeRangePicker } from "../metrics";

const ROW_HEIGHT = 375;

// moved MergesPanel and CiDurationsPanel to components

// Helper function to safely extract PR cycle data values
function getPrCycleValue(
  data: any[] | undefined,
  field: string
): number | null | undefined {
  if (data === undefined) return undefined;
  return data?.[0]?.[field] ?? null;
}

// Helper function to format hour values
function formatHours(v: number | null | undefined): string {
  return v === null || v === undefined ? "-" : Number(v).toFixed(2);
}

// Helper function to format hour values with unit
function formatHoursWithUnit(v: number | null | undefined): string {
  return v === null || v === undefined ? "-" : Number(v).toFixed(2) + "h";
}

// Type for metric configuration
interface MetricConfig {
  title: string;
  value: number | null | undefined;
  valueRenderer: (v: number | null | undefined) => string;
  badThreshold: (v: number | null | undefined) => boolean;
  paperSx?: any;
}

// Helper component to render a stack of metric panels from config
function MetricStack({ metrics }: { metrics: MetricConfig[] }) {
  return (
    <>
      {metrics.map((metric, index) => (
        <ScalarPanelWithValue
          key={index}
          title={metric.title}
          value={metric.value}
          valueRenderer={metric.valueRenderer}
          badThreshold={metric.badThreshold}
          paperSx={metric.paperSx}
        />
      ))}
    </>
  );
}

export default function Page() {
  const { darkMode } = useDarkMode();
  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [timeRange, setTimeRange] = useState<number>(7);

  const timeParams = {
    startTime: startTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: stopTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
  };

  const { data, isLoading } = useClickHouseAPIImmutable(
    "vllm/merges_percentage",
    {
      ...timeParams,
      granularity: "day",
      repo: "vllm-project/vllm",
    }
  );

  const { data: ciDurations } = useClickHouseAPIImmutable(
    "vllm/ci_run_duration",
    {
      ...timeParams,
      // Buildkite uses full repo URL with .git in vLLM dataset
      repo: "https://github.com/vllm-project/vllm.git",
      pipelineName: "CI",
    }
  );

  // Compute CI P50/P90 from returned rows
  const points = (ciDurations || []) as any[];
  const successStatesSet = new Set(["passed", "finished", "success"]);
  const successDurations = points
    .filter((d: any) =>
      successStatesSet.has(String(d.build_state || "").toLowerCase())
    )
    .map((d: any) => Number(d.duration_hours))
    .filter((x: number) => Number.isFinite(x))
    .sort((a: number, b: number) => a - b);
  const nonCanceledDurations = points
    .filter((d: any) => {
      const s = String(d.build_state || "").toLowerCase();
      return s !== "canceled" && s !== "cancelled";
    })
    .map((d: any) => Number(d.duration_hours))
    .filter((x: number) => Number.isFinite(x))
    .sort((a: number, b: number) => a - b);
  const qFrom = (arr: number[], p: number) =>
    arr.length ? arr[Math.floor((arr.length - 1) * p)] : null;
  const ciSuccP50 =
    ciDurations === undefined ? undefined : qFrom(successDurations, 0.5);
  const ciSuccP90 =
    ciDurations === undefined ? undefined : qFrom(successDurations, 0.9);
  const ciNCancP50 =
    ciDurations === undefined ? undefined : qFrom(nonCanceledDurations, 0.5);
  const ciNCancP90 =
    ciDurations === undefined ? undefined : qFrom(nonCanceledDurations, 0.9);

  const { data: prCycleData } = useClickHouseAPIImmutable(
    "vllm/pr_cycle_time_breakdown",
    {
      ...timeParams,
      repo: "vllm-project/vllm",
    }
  );

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const manualMergedFailures =
    data === undefined || data.length === 0
      ? 0
      : _.sumBy(data, "manual_merged_with_failures_count");
  const manualMerged =
    data === undefined || data.length === 0
      ? 0
      : _.sumBy(data, "manual_merged_count");
  const autoMerged =
    data === undefined || data.length === 0
      ? 0
      : _.sumBy(data, "auto_merged_count");
  const total = manualMergedFailures + manualMerged + autoMerged;

  // Show their percentages instead the absolute count
  const manualMergedFailuresPct =
    total === 0 ? 0 : manualMergedFailures / total;
  const manualMergedPct = total == 0 ? 0 : manualMerged / total;

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          vLLM CI Metrics
        </Typography>
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
      </Stack>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 6 }} height={ROW_HEIGHT}>
          <MergesPanel data={data} />
        </Grid>

        <Grid
          container
          size={{ xs: 6, md: 3, lg: 2 }}
          justifyContent={"stretch"}
        >
          <Stack
            justifyContent={"space-between"}
            flexGrow={1}
            flexWrap="wrap"
            spacing={1}
          >
            <ScalarPanelWithValue
              title={"% force merges (with failures)"}
              value={manualMergedFailuresPct}
              valueRenderer={(value) => (value * 100).toFixed(1) + "%"}
              badThreshold={(value) => value > 0.2}
            />
            <ScalarPanelWithValue
              title={"% manual merges"}
              value={manualMergedPct}
              valueRenderer={(value) => (value * 100).toFixed(1) + "%"}
              badThreshold={(value) => value > 0.5}
            />
          </Stack>
        </Grid>
      </Grid>

      <Grid container spacing={2} sx={{ mt: 2 }}>
        <Grid size={{ xs: 12, md: 6 }} height={ROW_HEIGHT}>
          <CiDurationsPanel data={ciDurations} />
        </Grid>
        <Grid
          container
          size={{ xs: 12, md: 3, lg: 2 }}
          justifyContent={"stretch"}
        >
          <Stack spacing={1} sx={{ width: "100%", height: ROW_HEIGHT }}>
            <MetricStack
              metrics={[
                {
                  title: "CI P50 (success)",
                  value: ciSuccP50,
                  valueRenderer: formatHoursWithUnit,
                  badThreshold: (v) => (v ?? 0) > 2,
                  paperSx: { height: "50%" },
                },
                {
                  title: "CI Runtime P90 (success)",
                  value: ciSuccP90,
                  valueRenderer: formatHoursWithUnit,
                  badThreshold: (v) => (v ?? 0) > 6,
                  paperSx: { height: "50%" },
                },
              ]}
            />
          </Stack>
        </Grid>
        <Grid
          container
          size={{ xs: 12, md: 3, lg: 2 }}
          justifyContent={"stretch"}
        >
          <Stack spacing={1} sx={{ width: "100%", height: ROW_HEIGHT }}>
            <MetricStack
              metrics={[
                {
                  title: "CI P50 (success+failed)",
                  value: ciNCancP50,
                  valueRenderer: formatHoursWithUnit,
                  badThreshold: (v) => (v ?? 0) > 2,
                  paperSx: { height: "50%" },
                },
                {
                  title: "CI Runtime P90 (success+failed)",
                  value: ciNCancP90,
                  valueRenderer: formatHoursWithUnit,
                  badThreshold: (v) => (v ?? 0) > 6,
                  paperSx: { height: "50%" },
                },
              ]}
            />
          </Stack>
        </Grid>
        <Grid size={{ xs: 12, md: 0, lg: 2 }} />
      </Grid>

      <Grid container spacing={2} sx={{ mt: 2 }}>
        <Grid
          container
          size={{ xs: 12, md: 3, lg: 2 }}
          justifyContent={"stretch"}
        >
          <Stack spacing={1} sx={{ width: "100%" }}>
            <MetricStack
              metrics={[
                {
                  title: "P50 time to first review (hrs)",
                  value: getPrCycleValue(
                    prCycleData,
                    "time_to_first_review_p50"
                  ),
                  valueRenderer: formatHours,
                  badThreshold: (v) => (v ?? 0) > 24,
                },
                {
                  title: "P90 time to first review (hrs)",
                  value: getPrCycleValue(
                    prCycleData,
                    "time_to_first_review_p90"
                  ),
                  valueRenderer: formatHours,
                  badThreshold: (v) => (v ?? 0) > 72,
                },
                {
                  title: "P50 time to approval (hrs)",
                  value: getPrCycleValue(prCycleData, "time_to_approval_p50"),
                  valueRenderer: formatHours,
                  badThreshold: (v) => (v ?? 0) > 48,
                },
              ]}
            />
          </Stack>
        </Grid>
        <Grid
          container
          size={{ xs: 12, md: 3, lg: 2 }}
          justifyContent={"stretch"}
        >
          <Stack spacing={1} sx={{ width: "100%" }}>
            <MetricStack
              metrics={[
                {
                  title: "P90 time to approval (hrs)",
                  value: getPrCycleValue(prCycleData, "time_to_approval_p90"),
                  valueRenderer: formatHours,
                  badThreshold: (v) => (v ?? 0) > 120,
                },
                {
                  title: "P50 time in merge queue (hrs)",
                  value: getPrCycleValue(
                    prCycleData,
                    "time_in_merge_queue_p50"
                  ),
                  valueRenderer: formatHours,
                  badThreshold: (v) => (v ?? 0) > 24,
                },
                {
                  title: "P90 time in merge queue (hrs)",
                  value: getPrCycleValue(
                    prCycleData,
                    "time_in_merge_queue_p90"
                  ),
                  valueRenderer: formatHours,
                  badThreshold: (v) => (v ?? 0) > 72,
                },
              ]}
            />
          </Stack>
        </Grid>
        <Grid size={{ xs: 12, md: 6, lg: 8 }} />
      </Grid>
    </div>
  );
}
