import { Box, Divider, Grid, Skeleton, Stack, Typography } from "@mui/material";
import { ScalarPanelWithValue } from "components/metrics/panels/ScalarPanel";
import CiDurationsPanel from "components/metrics/vllm/CiDurationsPanel";
import DurationDistributionPanel from "components/metrics/vllm/DurationDistributionPanel";
import JobReliabilityPanel from "components/metrics/vllm/JobReliabilityPanel";
import MergesPanel from "components/metrics/vllm/MergesPanel";
import ReliabilityPanel from "components/metrics/vllm/ReliabilityPanel";
import ReliabilityTrendPanel from "components/metrics/vllm/ReliabilityTrendPanel";
import TrunkHealthPanel from "components/metrics/vllm/TrunkHealthPanel";
import TrunkRecoveryPanel from "components/metrics/vllm/TrunkRecoveryPanel";
import dayjs from "dayjs";
import { useDarkMode } from "lib/DarkModeContext";
import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import _ from "lodash";
import React, { useState } from "react";
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

// Helper function to format percentage values
function formatPercentage(v: number | null | undefined): string {
  return v === null || v === undefined ? "-" : (v * 100).toFixed(1) + "%";
}

// Helper function to format count values
function formatCount(v: number | null | undefined): string {
  return v === null || v === undefined ? "-" : v.toString();
}

// Type for metric configuration
interface MetricConfig {
  title: string;
  value: number | null | undefined;
  valueRenderer: (v: number | null | undefined) => string;
  badThreshold: (v: number | null | undefined) => boolean;
  tooltip?: string;
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
          tooltip={metric.tooltip}
          paperSx={metric.paperSx}
        />
      ))}
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
        <MetricStack metrics={metrics} />
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

  const { data: reliabilityData } = useClickHouseAPIImmutable(
    "vllm/ci_reliability",
    {
      ...timeParams,
      granularity: "day",
      repo: "https://github.com/vllm-project/vllm.git",
      pipelineName: "CI",
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
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          metrics={[
            {
              title: "% force merges (all)",
              value: manualMergedFailuresPct,
              valueRenderer: formatPercentage,
              badThreshold: (v) => (v ?? 0) > 0.2,
              tooltip:
                "Percentage of merged PRs that had hard-failing tests at merge time. These were manually merged (GitHub auto-merge disabled) despite CI failures. High values indicate tests being bypassed.",
            },
            {
              title: "% manual merges",
              value: manualMergedPct,
              valueRenderer: formatPercentage,
              badThreshold: (v) => (v ?? 0) > 0.5,
              tooltip:
                "Percentage of merged PRs where a human clicked 'Merge' button instead of using GitHub auto-merge. Includes both clean manual merges AND force merges. High values may indicate slow merge queues or low CI trust.",
            },
          ]}
        />
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          metrics={[
            {
              title: "Overall Success Rate",
              value: overallSuccessRate,
              valueRenderer: formatPercentage,
              badThreshold: (v) => (v ?? 1) < 0.85,
              tooltip:
                "Percentage of main branch builds with zero hard test failures. Builds with only soft failures (flaky tests) count as passed. Canceled builds excluded from calculation.",
            },
            {
              title: "Main branch health %",
              value: trunkHealthPct,
              valueRenderer: formatPercentage,
              badThreshold: (v) => (v ?? 1) < 0.9,
              tooltip:
                "Percentage of days where main branch ended green (most recent build of the day passed). Lower values mean trunk is frequently broken.",
            },
          ]}
        />
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          metrics={[
            {
              title: "Avg recovery time",
              value: avgRecoveryTime,
              valueRenderer: formatHoursWithUnit,
              badThreshold: (v) => (v ?? 0) > 12,
              tooltip:
                "Average time to fix main branch when it breaks. Measures from first failed CI run (trunk breaks) to first successful CI run (trunk recovers). Lower is better.",
            },
            {
              title: "Total Failed Builds",
              value: reliabilityData === undefined ? undefined : totalFailed,
              valueRenderer: formatCount,
              badThreshold: (v) => (v ?? 0) > 10,
              tooltip:
                "Count of main branch CI runs with hard test failures (soft failures excluded) in selected time period.",
            },
          ]}
        />
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          metrics={[
            {
              title: "CI Time to green P50",
              value: ciSuccP50,
              valueRenderer: formatHoursWithUnit,
              badThreshold: (v) => (v ?? 0) > 2,
              tooltip:
                "Median (P50) CI runtime for successful main branch runs. Half of successful CI runs complete faster than this. Measures how long developers wait for green checkmark.",
            },
            {
              title: "CI Time to green P90",
              value: ciSuccP90,
              valueRenderer: formatHoursWithUnit,
              badThreshold: (v) => (v ?? 0) > 6,
              tooltip:
                "90th percentile (P90) CI runtime for successful main branch runs. 90% of successful CI runs complete faster than this.",
            },
          ]}
        />
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          metrics={[
            {
              title: "P50 time to first review",
              value: getPrCycleValue(prCycleData, "time_to_first_review_p50"),
              valueRenderer: formatHoursWithUnit,
              badThreshold: (v) => (v ?? 0) > 24,
              tooltip:
                "Median time from PR ready (labeled 'ready' or created) to first human review comment. Excludes bot reviews.",
            },
          ]}
        />
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          metrics={[
            {
              title: "P50 time to approval",
              value: getPrCycleValue(prCycleData, "time_to_approval_p50"),
              valueRenderer: formatHoursWithUnit,
              badThreshold: (v) => (v ?? 0) > 48,
              tooltip:
                "Median time from first human review to first approval from a maintainer (MEMBER/OWNER/COLLABORATOR).",
            },
          ]}
        />
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          metrics={[
            {
              title: "P50 merge queue time",
              value: getPrCycleValue(prCycleData, "time_in_merge_queue_p50"),
              valueRenderer: formatHoursWithUnit,
              badThreshold: (v) => (v ?? 0) > 24,
              tooltip:
                "Median time from first approval to actual merge. Measures how long PRs wait in the merge queue after approval.",
            },
          ]}
        />
        <MetricColumn
          size={{ xs: 6, md: 3, lg: 2 }}
          metrics={[
            {
              title: "P90 merge queue time",
              value: getPrCycleValue(prCycleData, "time_in_merge_queue_p90"),
              valueRenderer: formatHoursWithUnit,
              badThreshold: (v) => (v ?? 0) > 72,
              tooltip:
                "90th percentile time from approval to merge. 90% of PRs merge faster than this after approval.",
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
        <Grid size={{ xs: 12, md: 6 }} height={ROW_HEIGHT}>
          <ReliabilityPanel data={reliabilityData} />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }} height={ROW_HEIGHT}>
          <ReliabilityTrendPanel data={reliabilityData} />
        </Grid>
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
        <Grid size={{ xs: 12, md: 12 }} height={ROW_HEIGHT}>
          <JobReliabilityPanel data={jobReliabilityData} />
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

      {/* Section 4: PR Cycle Metrics */}
      <Divider sx={{ mt: 4, mb: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: "bold" }}>
          PR Cycle Metrics
        </Typography>
      </Divider>
      <DashboardRow spacing={2}>
        <Grid size={{ xs: 12 }} height={ROW_HEIGHT}>
          <MergesPanel data={data} />
        </Grid>
      </DashboardRow>
    </div>
  );
}
