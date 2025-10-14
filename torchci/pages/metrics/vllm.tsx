import { Box, Divider, Grid, Skeleton, Stack, Typography } from "@mui/material";
import CiDurationsPanel from "components/metrics/vllm/CiDurationsPanel";
import CommitsOnRedTrendPanel from "components/metrics/vllm/CommitsOnRedTrendPanel";
import DurationDistributionPanel from "components/metrics/vllm/DurationDistributionPanel";
import JobReliabilityPanel from "components/metrics/vllm/JobReliabilityPanel";
import MergesPanel from "components/metrics/vllm/MergesPanel";
import MostRetriedJobsTable from "components/metrics/vllm/MostRetriedJobsTable";
import ReliabilityPanel from "components/metrics/vllm/ReliabilityPanel";
import ReliabilityTrendPanel from "components/metrics/vllm/ReliabilityTrendPanel";
import RetryTrendPanel from "components/metrics/vllm/RetryTrendPanel";
import TimeToSignalTrendPanel from "components/metrics/vllm/TimeToSignalTrendPanel";
import TrunkHealthPanel from "components/metrics/vllm/TrunkHealthPanel";
import TrunkHealthTrendPanel from "components/metrics/vllm/TrunkHealthTrendPanel";
import TrunkRecoveryPanel from "components/metrics/vllm/TrunkRecoveryPanel";
import UnreliableJobsTable from "components/metrics/vllm/UnreliableJobsTable";
import {
  VllmDualScalarPanel,
  VllmScalarPanel,
} from "components/metrics/vllm/VllmScalarPanel";
import dayjs from "dayjs";
import { useDarkMode } from "lib/DarkModeContext";
import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import _ from "lodash";
import React, { useState } from "react";
import { TimeRangePicker } from "../metrics";

const ROW_HEIGHT = 375;
const METRIC_CARD_HEIGHT = 200; // Height for key metric cards (reduced by ~20% from default)

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

// Helper function to format percentage values
function formatPercentage(v: number | null | undefined): string {
  return v === null || v === undefined ? "-" : (v * 100).toFixed(1) + "%";
}

// Helper function to format count values
function formatCount(v: number | null | undefined): string {
  return v === null || v === undefined ? "-" : v.toString();
}

// Helper function to calculate percentage point delta
function calculateDelta(
  current: number | null | undefined,
  previous: number | null | undefined
): number | null {
  if (
    current === null ||
    current === undefined ||
    previous === null ||
    previous === undefined
  ) {
    return null;
  }
  // Return percentage point difference (not relative change)
  return (current - previous) * 100;
}

// Helper function to calculate relative percentage change (for absolute values like hours)
function calculateRelativeDelta(
  current: number | null | undefined,
  previous: number | null | undefined
): number | null {
  if (
    current === null ||
    current === undefined ||
    previous === null ||
    previous === undefined ||
    previous === 0
  ) {
    return null;
  }
  // Return percentage change
  return ((current - previous) / previous) * 100;
}

// Type for metric configuration (supports both single and dual values)
interface MetricConfig {
  title: string;
  value: number | null | undefined;
  valueRenderer: (v: number | null | undefined) => string;
  badThreshold: (v: number | null | undefined) => boolean;
  tooltip?: string;
  paperSx?: any;
  // Optional: for showing change vs previous period (always shown as %)
  // Color: green if positive, red if negative
  delta?: number | null;
  // Optional: for dual-value metrics (P50/P90 pairs)
  value2?: number | null | undefined;
  badThreshold2?: (v: number | null | undefined) => boolean;
  delta2?: number | null;
  label1?: string;
  label2?: string;
}

// Helper component to render a stack of metric panels from config
function MetricStack({
  metrics,
  height,
}: {
  metrics: MetricConfig[];
  height?: number | string;
}) {
  return (
    <>
      {metrics.map((metric, index) => {
        // Render dual-value panel if value2 is provided
        if (metric.value2 !== undefined && metric.badThreshold2) {
          return (
            <VllmDualScalarPanel
              key={index}
              title={metric.title}
              value1={metric.value}
              value2={metric.value2}
              label1={metric.label1}
              label2={metric.label2}
              valueRenderer={metric.valueRenderer}
              badThreshold1={metric.badThreshold}
              badThreshold2={metric.badThreshold2}
              tooltip={metric.tooltip}
              delta1={metric.delta}
              delta2={metric.delta2}
            />
          );
        }
        // Render single-value panel
        return (
          <VllmScalarPanel
            key={index}
            title={metric.title}
            value={metric.value}
            valueRenderer={metric.valueRenderer}
            badThreshold={metric.badThreshold}
            tooltip={metric.tooltip}
            delta={metric.delta}
          />
        );
      })}
    </>
  );
}

// Helper component for a metrics column
function MetricColumn({
  metrics,
  height,
  size = { xs: 12, md: 3, lg: 2 },
}: {
  metrics: MetricConfig[];
  height?: string | number;
  size?: { xs: number; md: number; lg?: number };
}) {
  return (
    <Grid container size={size} justifyContent={"stretch"}>
      <Stack spacing={1} sx={{ width: "100%", height: height || "auto" }}>
        <MetricStack metrics={metrics} height={height} />
      </Stack>
    </Grid>
  );
}

// Helper component for a dashboard row with consistent spacing
function DashboardRow({
  children,
  spacing = 2,
}: {
  children: React.ReactNode;
  spacing?: number;
}) {
  return (
    <Grid container spacing={spacing} sx={{ mt: spacing }}>
      {children}
    </Grid>
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

  // Previous period params for delta calculation
  const duration = stopTime.diff(startTime);
  const prevStartTime = startTime.subtract(duration);
  const prevStopTime = startTime;

  const prevTimeParams = {
    startTime: prevStartTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: prevStopTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
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

  const { data: prevCiDurations } = useClickHouseAPIImmutable(
    "vllm/ci_run_duration",
    {
      ...prevTimeParams,
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

  // Compute previous period CI P50/P90
  const prevPoints = (prevCiDurations || []) as any[];
  const prevSuccessDurations = prevPoints
    .filter((d: any) =>
      successStatesSet.has(String(d.build_state || "").toLowerCase())
    )
    .map((d: any) => Number(d.duration_hours))
    .filter((x: number) => Number.isFinite(x))
    .sort((a: number, b: number) => a - b);
  const prevCiSuccP50 =
    prevCiDurations === undefined
      ? undefined
      : qFrom(prevSuccessDurations, 0.5);
  const prevCiSuccP90 =
    prevCiDurations === undefined
      ? undefined
      : qFrom(prevSuccessDurations, 0.9);

  const { data: prCycleData } = useClickHouseAPIImmutable(
    "vllm/pr_cycle_time_breakdown",
    {
      ...timeParams,
      repo: "vllm-project/vllm",
    }
  );

  const { data: prevPrCycleData } = useClickHouseAPIImmutable(
    "vllm/pr_cycle_time_breakdown",
    {
      ...prevTimeParams,
      repo: "vllm-project/vllm",
    }
  );

  const { data: reliabilityData } = useClickHouseAPIImmutable(
    "vllm/ci_reliability",
    {
      ...timeParams,
      granularity: "day",
      repo: "https://github.com/vllm-project/vllm.git",
      pipelineName: "CI",
    }
  );

  const { data: retryData } = useClickHouseAPIImmutable("vllm/rebuild_rate", {
    ...timeParams,
    granularity: "day",
    repo: "https://github.com/vllm-project/vllm.git",
    pipelineName: "CI",
  });

  const { data: jobRetryStatsData } = useClickHouseAPIImmutable(
    "vllm/job_retry_stats",
    {
      ...timeParams,
      repo: "https://github.com/vllm-project/vllm.git",
      pipelineName: "CI",
      minRuns: 5,
    }
  );

  const { data: jobReliabilityData } = useClickHouseAPIImmutable(
    "vllm/job_reliability",
    {
      ...timeParams,
      repo: "https://github.com/vllm-project/vllm.git",
      pipelineName: "CI",
      minRuns: 3,
    }
  );

  const { data: trunkHealthData } = useClickHouseAPIImmutable(
    "vllm/trunk_health",
    {
      ...timeParams,
      granularity: "day",
      repo: "https://github.com/vllm-project/vllm.git",
      pipelineName: "CI",
    }
  );

  const { data: trunkRecoveryData } = useClickHouseAPIImmutable(
    "vllm/trunk_recovery_time",
    {
      ...timeParams,
      repo: "https://github.com/vllm-project/vllm.git",
      pipelineName: "CI",
    }
  );

  // Fetch previous period data for delta calculations
  const { data: prevReliabilityData } = useClickHouseAPIImmutable(
    "vllm/ci_reliability",
    {
      ...prevTimeParams,
      granularity: "day",
      repo: "https://github.com/vllm-project/vllm.git",
      pipelineName: "CI",
    }
  );

  const { data: prevTrunkHealthData } = useClickHouseAPIImmutable(
    "vllm/trunk_health",
    {
      ...prevTimeParams,
      granularity: "day",
      repo: "https://github.com/vllm-project/vllm.git",
      pipelineName: "CI",
    }
  );

  const { data: prevMergesData } = useClickHouseAPIImmutable(
    "vllm/merges_percentage",
    {
      ...prevTimeParams,
      granularity: "day",
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

  // Total merged PRs = manual (includes force) + auto
  // Note: manual_merged_count INCLUDES manual_merged_with_failures_count
  const totalMerged = manualMerged + autoMerged;

  // Show their percentages instead of absolute counts
  const manualMergedFailuresPct =
    totalMerged === 0 ? 0 : manualMergedFailures / totalMerged;
  const manualMergedPct = totalMerged === 0 ? 0 : manualMerged / totalMerged;

  // Compute overall reliability metrics
  const reliabilityPoints = (reliabilityData || []) as any[];
  const totalPassed = _.sumBy(reliabilityPoints, "passed_count");
  const totalFailed = _.sumBy(reliabilityPoints, "failed_count");
  const totalCanceled = _.sumBy(reliabilityPoints, "canceled_count");
  const totalNonCanceled = totalPassed + totalFailed;
  const overallSuccessRate =
    reliabilityData === undefined
      ? undefined
      : totalNonCanceled === 0
      ? null
      : totalPassed / totalNonCanceled;

  // Compute retry rate
  const retryPoints = (retryData || []) as any[];
  const totalJobs = _.sumBy(retryPoints, "total_jobs");
  const totalRetries = _.sumBy(retryPoints, "retried_count");
  const overallRetryRate =
    retryData === undefined
      ? undefined
      : totalJobs === 0
      ? null
      : totalRetries / totalJobs;

  // Compute trunk health metrics
  // Data now contains individual builds, group by day to get daily status
  const trunkHealthPoints = (trunkHealthData || []) as any[];
  const buildsByDay = _.groupBy(trunkHealthPoints, (d) =>
    d.build_started_at ? d.build_started_at.slice(0, 10) : ""
  );
  const dailyStatus = Object.entries(buildsByDay).map(([day, builds]) => {
    // Day is green if the most recent build was green
    const sortedBuilds = _.sortBy(builds, "build_started_at");
    const mostRecent = sortedBuilds[sortedBuilds.length - 1];
    return { day, isGreen: mostRecent?.is_green === 1 };
  });
  const greenDays = dailyStatus.filter((d) => d.isGreen).length;
  const totalDays = dailyStatus.length;
  const trunkHealthPct =
    trunkHealthData === undefined
      ? undefined
      : totalDays === 0
      ? null
      : greenDays / totalDays;

  // Process trunk health data for daily trend chart
  const dailyTrunkHealthData = Object.entries(buildsByDay)
    .map(([day, builds]) => {
      const greenBuilds = builds.filter((b: any) => b.is_green === 1).length;
      const redBuilds = builds.length - greenBuilds;
      return {
        day,
        green_count: greenBuilds,
        red_count: redBuilds,
        total_count: builds.length,
      };
    })
    .sort((a, b) => a.day.localeCompare(b.day));

  // Calculate % commits on red (opposite of trunk health)
  const commitsOnRedPct =
    trunkHealthPct === undefined
      ? undefined
      : trunkHealthPct === null
      ? null
      : 1 - trunkHealthPct;

  // Calculate previous period metrics for deltas
  const prevReliabilityPoints = (prevReliabilityData || []) as any[];
  const prevTotalPassed = _.sumBy(prevReliabilityPoints, "passed_count");
  const prevTotalFailed = _.sumBy(prevReliabilityPoints, "failed_count");
  const prevTotalNonCanceled = prevTotalPassed + prevTotalFailed;
  const prevOverallSuccessRate =
    prevReliabilityData === undefined
      ? undefined
      : prevTotalNonCanceled === 0
      ? null
      : prevTotalPassed / prevTotalNonCanceled;

  const prevTrunkHealthPoints = (prevTrunkHealthData || []) as any[];
  const prevBuildsByDay = _.groupBy(prevTrunkHealthPoints, (d) =>
    d.build_started_at ? d.build_started_at.slice(0, 10) : ""
  );
  const prevDailyStatus = Object.entries(prevBuildsByDay).map(
    ([day, builds]) => {
      const sortedBuilds = _.sortBy(builds, "build_started_at");
      const mostRecent = sortedBuilds[sortedBuilds.length - 1];
      return { day, isGreen: mostRecent?.is_green === 1 };
    }
  );
  const prevGreenDays = prevDailyStatus.filter((d) => d.isGreen).length;
  const prevTotalDays = prevDailyStatus.length;
  const prevTrunkHealthPct =
    prevTrunkHealthData === undefined
      ? undefined
      : prevTotalDays === 0
      ? null
      : prevGreenDays / prevTotalDays;

  const prevCommitsOnRedPct =
    prevTrunkHealthPct === undefined
      ? undefined
      : prevTrunkHealthPct === null
      ? null
      : 1 - prevTrunkHealthPct;

  const prevManualMergedFailures =
    prevMergesData === undefined || prevMergesData.length === 0
      ? 0
      : _.sumBy(prevMergesData, "manual_merged_with_failures_count");
  const prevManualMerged =
    prevMergesData === undefined || prevMergesData.length === 0
      ? 0
      : _.sumBy(prevMergesData, "manual_merged_count");
  const prevAutoMerged =
    prevMergesData === undefined || prevMergesData.length === 0
      ? 0
      : _.sumBy(prevMergesData, "auto_merged_count");
  const prevTotalMerged = prevManualMerged + prevAutoMerged;
  const prevManualMergedFailuresPct =
    prevTotalMerged === 0 ? 0 : prevManualMergedFailures / prevTotalMerged;

  // Calculate deltas (percentage point changes)
  const trunkHealthDelta = calculateDelta(trunkHealthPct, prevTrunkHealthPct);
  const commitsOnRedDelta = calculateDelta(
    commitsOnRedPct,
    prevCommitsOnRedPct
  );
  const forceMergesDelta = calculateDelta(
    manualMergedFailuresPct,
    prevManualMergedFailuresPct
  );
  const overallSuccessRateDelta = calculateDelta(
    overallSuccessRate,
    prevOverallSuccessRate
  );

  // Calculate deltas for CI times (relative percentage change for hours)
  const ciSuccP50Delta = calculateRelativeDelta(ciSuccP50, prevCiSuccP50);
  const ciSuccP90Delta = calculateRelativeDelta(ciSuccP90, prevCiSuccP90);

  // Calculate deltas for PR cycle times
  const prevMergeQueueP50 = getPrCycleValue(
    prevPrCycleData,
    "time_in_merge_queue_p50"
  );
  const prevMergeQueueP90 = getPrCycleValue(
    prevPrCycleData,
    "time_in_merge_queue_p90"
  );
  const mergeQueueP50Delta = calculateRelativeDelta(
    getPrCycleValue(prCycleData, "time_in_merge_queue_p50"),
    prevMergeQueueP50
  );
  const mergeQueueP90Delta = calculateRelativeDelta(
    getPrCycleValue(prCycleData, "time_in_merge_queue_p90"),
    prevMergeQueueP90
  );

  // Calculate delta for total failed builds (relative percentage change)
  const totalFailedDelta = calculateRelativeDelta(
    reliabilityData === undefined ? undefined : totalFailed,
    prevReliabilityData === undefined ? undefined : prevTotalFailed
  );

  // Calculate delta for manual merges percentage
  const prevManualMergedPct =
    prevTotalMerged === 0 ? 0 : prevManualMerged / prevTotalMerged;
  const manualMergedPctDelta = calculateDelta(
    manualMergedPct,
    prevManualMergedPct
  );

  // Calculate deltas for time to first review
  const prevTimeToReviewP50 = getPrCycleValue(
    prevPrCycleData,
    "time_to_first_review_p50"
  );
  const prevTimeToReviewP90 = getPrCycleValue(
    prevPrCycleData,
    "time_to_first_review_p90"
  );
  const timeToReviewP50Delta = calculateRelativeDelta(
    getPrCycleValue(prCycleData, "time_to_first_review_p50"),
    prevTimeToReviewP50
  );
  const timeToReviewP90Delta = calculateRelativeDelta(
    getPrCycleValue(prCycleData, "time_to_first_review_p90"),
    prevTimeToReviewP90
  );

  // Calculate deltas for time to approval
  const prevTimeToApprovalP50 = getPrCycleValue(
    prevPrCycleData,
    "time_to_approval_p50"
  );
  const prevTimeToApprovalP90 = getPrCycleValue(
    prevPrCycleData,
    "time_to_approval_p90"
  );
  const timeToApprovalP50Delta = calculateRelativeDelta(
    getPrCycleValue(prCycleData, "time_to_approval_p50"),
    prevTimeToApprovalP50
  );
  const timeToApprovalP90Delta = calculateRelativeDelta(
    getPrCycleValue(prCycleData, "time_to_approval_p90"),
    prevTimeToApprovalP90
  );

  // Compute average recovery time
  const recoveryTimes = (trunkRecoveryData || []) as any[];
  const avgRecoveryTime =
    trunkRecoveryData === undefined
      ? undefined
      : recoveryTimes.length === 0
      ? null
      : _.meanBy(recoveryTimes, "recovery_hours");

  return (
    <div style={{ paddingTop: "16px" }}>
      <Stack
        direction="row"
        spacing={2}
        sx={{ mb: 3, pb: 2, alignItems: "flex-start", flexWrap: "wrap" }}
      >
        <Typography
          fontSize={"2rem"}
          fontWeight={"bold"}
          sx={{ flexShrink: 0 }}
        >
          vLLM CI Metrics
        </Typography>
        <Box sx={{ flexGrow: 1, minWidth: "300px" }}>
          <TimeRangePicker
            startTime={startTime}
            setStartTime={setStartTime}
            stopTime={stopTime}
            setStopTime={setStopTime}
            timeRange={timeRange}
            setTimeRange={setTimeRange}
          />
        </Box>
      </Stack>

      {/* Section 1: Key Metrics Summary Cards */}
      <Divider sx={{ mt: 3, mb: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: "bold" }}>
          Key Metrics Overview
        </Typography>
      </Divider>
      <DashboardRow spacing={2}>
        {/* Reliability Metrics */}
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          height={METRIC_CARD_HEIGHT}
          metrics={[
            {
              title: "Trunk health %",
              value: trunkHealthPct,
              valueRenderer: formatPercentage,
              badThreshold: (v) => (v ?? 1) < 0.9,
              tooltip:
                "Percentage of days where main branch ended green (most recent build of the day passed). Lower values mean trunk is frequently broken.",
              delta: trunkHealthDelta,
            },
          ]}
        />
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          height={METRIC_CARD_HEIGHT}
          metrics={[
            {
              title: "% commits on red",
              value: commitsOnRedPct,
              valueRenderer: formatPercentage,
              badThreshold: (v) => (v ?? 0) > 0.1,
              tooltip:
                "Percentage of days where main branch ended red (most recent build of the day failed). High values mean developers are committing to a broken trunk.",
              delta: commitsOnRedDelta,
            },
          ]}
        />
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          height={METRIC_CARD_HEIGHT}
          metrics={[
            {
              title: "% force merges",
              value: manualMergedFailuresPct,
              valueRenderer: formatPercentage,
              badThreshold: (v) => (v ?? 0) > 0.2,
              tooltip:
                "Percentage of merged PRs that had hard-failing tests at merge time. These were manually merged (GitHub auto-merge disabled) despite CI failures. High values indicate tests being bypassed.",
              delta: forceMergesDelta,
            },
          ]}
        />
        {/* Latency Metrics */}
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          height={METRIC_CARD_HEIGHT}
          metrics={[
            {
              title: "Time to signal",
              value: ciSuccP50,
              value2: ciSuccP90,
              label1: "P50",
              label2: "P90",
              valueRenderer: formatHoursWithUnit,
              badThreshold: (v) => (v ?? 0) > 2,
              badThreshold2: (v) => (v ?? 0) > 6,
              tooltip:
                "CI runtime for successful main branch runs. P50 = median (half complete faster), P90 = 90th percentile (90% complete faster). Measures how long developers wait for green checkmark.",
              delta: ciSuccP50Delta,
              delta2: ciSuccP90Delta,
            },
          ]}
        />
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          height={METRIC_CARD_HEIGHT}
          metrics={[
            {
              title: "Approval to merge",
              value: getPrCycleValue(prCycleData, "time_in_merge_queue_p50"),
              value2: getPrCycleValue(prCycleData, "time_in_merge_queue_p90"),
              label1: "P50",
              label2: "P90",
              valueRenderer: formatHoursWithUnit,
              badThreshold: (v) => (v ?? 0) > 24,
              badThreshold2: (v) => (v ?? 0) > 72,
              tooltip:
                "Time from first approval to actual merge. P50 = median, P90 = 90th percentile. Measures how long PRs wait in merge queue after approval.",
              delta: mergeQueueP50Delta,
              delta2: mergeQueueP90Delta,
            },
          ]}
        />
      </DashboardRow>

      {/* Section 2: CI Reliability */}
      <Divider sx={{ mt: 4, mb: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: "bold" }}>
          CI Reliability
        </Typography>
      </Divider>
      <DashboardRow spacing={2}>
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          height={METRIC_CARD_HEIGHT}
          metrics={[
            {
              title: "Overall Success Rate",
              value: overallSuccessRate,
              valueRenderer: formatPercentage,
              badThreshold: (v) => (v ?? 1) < 0.85,
              tooltip:
                "Percentage of main branch builds with zero hard test failures. Builds with only soft failures (flaky tests) count as passed. Canceled builds excluded from calculation.",
              delta: overallSuccessRateDelta,
            },
          ]}
        />
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          height={METRIC_CARD_HEIGHT}
          metrics={[
            {
              title: "Total Failed Builds",
              value: reliabilityData === undefined ? undefined : totalFailed,
              valueRenderer: formatCount,
              badThreshold: (v) => (v ?? 0) > 10,
              tooltip:
                "Count of main branch CI runs with hard test failures (soft failures excluded) in selected time period.",
              delta: totalFailedDelta,
            },
          ]}
        />
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          height={METRIC_CARD_HEIGHT}
          metrics={[
            {
              title: "% Jobs Retried",
              value: overallRetryRate,
              valueRenderer: formatPercentage,
              badThreshold: (v) => (v ?? 0) > 0.01,
              tooltip:
                "Percentage of jobs that were manually or automatically retried. Low values (<1%) indicate stable infrastructure. High values may indicate flaky tests or infrastructure issues.",
              delta: null, // TODO: Add delta when we have previous retry data
            },
          ]}
        />
      </DashboardRow>
      <DashboardRow spacing={2}>
        <Grid size={{ xs: 12, md: 6 }} height={ROW_HEIGHT}>
          <ReliabilityPanel data={reliabilityData} />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }} height={ROW_HEIGHT}>
          <ReliabilityTrendPanel data={reliabilityData} />
        </Grid>
      </DashboardRow>
      <DashboardRow spacing={2}>
        <Grid size={{ xs: 12, md: 6 }} height={ROW_HEIGHT}>
          <TrunkHealthTrendPanel data={dailyTrunkHealthData} />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }} height={ROW_HEIGHT}>
          <CommitsOnRedTrendPanel data={dailyTrunkHealthData} />
        </Grid>
      </DashboardRow>
      <DashboardRow spacing={2}>
        <Grid size={{ xs: 12, md: 6 }} height={ROW_HEIGHT}>
          <RetryTrendPanel data={retryData} />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }} height={ROW_HEIGHT}>
          <MostRetriedJobsTable data={jobRetryStatsData} />
        </Grid>
      </DashboardRow>
      <Divider sx={{ mt: 4, mb: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: "bold" }}>
          Trunk Health
        </Typography>
      </Divider>
      <DashboardRow spacing={2}>
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          height={METRIC_CARD_HEIGHT}
          metrics={[
            {
              title: "Avg recovery time",
              value: avgRecoveryTime,
              valueRenderer: formatHoursWithUnit,
              badThreshold: (v) => (v ?? 0) > 12,
              tooltip:
                "Average time to fix main branch when it breaks. Measures from first failed CI run (trunk breaks) to first successful CI run (trunk recovers). Lower is better.",
              delta: null, // TODO: Calculate when we have previous recovery data
            },
          ]}
        />
      </DashboardRow>
      <DashboardRow spacing={2}>
        <Grid size={{ xs: 12, md: 6 }} height={ROW_HEIGHT}>
          <TrunkHealthPanel data={trunkHealthData} />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }} height={ROW_HEIGHT}>
          <TrunkRecoveryPanel
            data={trunkRecoveryData}
            startTime={startTime.toDate()}
            stopTime={stopTime.toDate()}
          />
        </Grid>
      </DashboardRow>
      <DashboardRow spacing={2}>
        <Grid size={{ xs: 12, md: 6 }} height={ROW_HEIGHT}>
          <JobReliabilityPanel data={jobReliabilityData} />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }} height={ROW_HEIGHT}>
          <UnreliableJobsTable data={jobReliabilityData} />
        </Grid>
      </DashboardRow>

      {/* Section 3: CI Duration Analysis */}
      <Divider sx={{ mt: 4, mb: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: "bold" }}>
          CI Duration Analysis
        </Typography>
      </Divider>
      <DashboardRow spacing={2}>
        <Grid size={{ xs: 12, md: 6 }} height={ROW_HEIGHT}>
          <DurationDistributionPanel data={ciDurations} />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }} height={ROW_HEIGHT}>
          <CiDurationsPanel data={ciDurations} />
        </Grid>
      </DashboardRow>
      <DashboardRow spacing={2}>
        <Grid size={{ xs: 12 }} height={ROW_HEIGHT}>
          <TimeToSignalTrendPanel data={ciDurations} />
        </Grid>
      </DashboardRow>

      {/* Section 4: PR Cycle Metrics */}
      <Divider sx={{ mt: 4, mb: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: "bold" }}>
          PR Cycle Metrics
        </Typography>
      </Divider>
      <DashboardRow spacing={2}>
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          height={METRIC_CARD_HEIGHT}
          metrics={[
            {
              title: "% manual merges",
              value: manualMergedPct,
              valueRenderer: formatPercentage,
              badThreshold: (v) => (v ?? 0) > 0.5,
              tooltip:
                "Percentage of merged PRs where a human clicked 'Merge' button instead of using GitHub auto-merge. Includes both clean manual merges AND force merges. High values may indicate slow merge queues or low CI trust.",
              delta: manualMergedPctDelta,
            },
          ]}
        />
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          height={METRIC_CARD_HEIGHT}
          metrics={[
            {
              title: "Time to first review",
              value: getPrCycleValue(prCycleData, "time_to_first_review_p50"),
              value2: getPrCycleValue(prCycleData, "time_to_first_review_p90"),
              label1: "P50",
              label2: "P90",
              valueRenderer: formatHoursWithUnit,
              badThreshold: (v) => (v ?? 0) > 24,
              badThreshold2: (v) => (v ?? 0) > 72,
              tooltip:
                "Time from PR ready (labeled 'ready' or created) to first human review comment. P50 = median, P90 = 90th percentile. Excludes bot reviews.",
              delta: timeToReviewP50Delta,
              delta2: timeToReviewP90Delta,
            },
          ]}
        />
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          height={METRIC_CARD_HEIGHT}
          metrics={[
            {
              title: "Time to approval",
              value: getPrCycleValue(prCycleData, "time_to_approval_p50"),
              value2: getPrCycleValue(prCycleData, "time_to_approval_p90"),
              label1: "P50",
              label2: "P90",
              valueRenderer: formatHoursWithUnit,
              badThreshold: (v) => (v ?? 0) > 48,
              badThreshold2: (v) => (v ?? 0) > 120,
              tooltip:
                "Time from first human review to first approval from a maintainer (MEMBER/OWNER/COLLABORATOR). P50 = median, P90 = 90th percentile.",
              delta: timeToApprovalP50Delta,
              delta2: timeToApprovalP90Delta,
            },
          ]}
        />
      </DashboardRow>
      <DashboardRow spacing={2}>
        <Grid size={{ xs: 12 }} height={ROW_HEIGHT}>
          <MergesPanel data={data} />
        </Grid>
      </DashboardRow>
    </div>
  );
}
