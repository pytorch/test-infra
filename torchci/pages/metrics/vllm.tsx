import { Grid, Paper, Skeleton, Stack, Typography } from "@mui/material";
import { ScalarPanelWithValue } from "components/metrics/panels/ScalarPanel";
import dayjs from "dayjs";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useDarkMode } from "lib/DarkModeContext";
import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import _ from "lodash";
import { useState } from "react";
import { TimeRangePicker } from "../metrics";

const ROW_HEIGHT = 375;

function MergesPanel({ data }: { data: any }) {
  // Use the dark mode context to determine whether to use the dark theme
  const { darkMode } = useDarkMode();

  const options: EChartsOption = {
    title: {
      text: "Merged pull requests, by day",
      subtext: "",
    },
    grid: { top: 60, right: 8, bottom: 24, left: 36 },
    dataset: { source: data },
    xAxis: { type: "category" },
    yAxis: {
      type: "value",
    },
    series: [
      {
        type: "bar",
        stack: "all",
        encode: {
          x: "granularity_bucket",
          y: "auto_merged_count",
        },
      },
      {
        type: "bar",
        stack: "all",
        encode: {
          x: "granularity_bucket",
          y: "manual_merged_count",
        },
      },
      {
        type: "bar",
        stack: "all",
        encode: {
          x: "granularity_bucket",
          y: "manual_merged_with_failures_count",
        },
      },
    ],
    color: ["#3ba272", "#fc9403", "#ee6666"],
    tooltip: {
      trigger: "axis",
      formatter: (params: any) => {
        const manualMergedFailures =
          params[0].data.manual_merged_with_failures_count;
        const manualMerged = params[0].data.manual_merged_count;
        const autoMerged = params[0].data.auto_merged_count;
        const total = manualMergedFailures + manualMerged + autoMerged;

        const manualMergedFailuresPct =
          ((manualMergedFailures / total) * 100).toFixed(2) + "%";
        const manualMergedPct = ((manualMerged / total) * 100).toFixed(2) + "%";
        const autoMergedPct = ((autoMerged / total) * 100).toFixed(2) + "%";
        return `Force merges: ${manualMergedFailures} (${manualMergedFailuresPct})<br/>Manual merges: ${manualMerged} (${manualMergedPct})<br/>Auto merges: ${autoMerged} (${autoMergedPct})<br/>Total: ${total}`;
      },
    },
  };

  return (
    <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
      <ReactECharts
        theme={darkMode ? "dark-hud" : undefined}
        style={{ height: "100%", width: "100%" }}
        option={options}
      />
    </Paper>
  );
}

export default function Page() {
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
    </div>
  );
}
