import { Paper, Skeleton, Typography, useTheme } from "@mui/material";
import dayjs from "dayjs";
import ReactECharts from "echarts-for-react";
import {
  HISTORY_START_DATE,
  SLA_DAYS,
  WeeklyRow,
} from "lib/triage/issueTriage";

const CHART_HEIGHT = 320;

export function WeeklyChart({ rows }: { rows: WeeklyRow[] | undefined }) {
  const theme = useTheme();
  const data = rows ?? [];
  const option = {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    grid: { top: 40, left: 50, right: 20, bottom: 30 },
    xAxis: {
      type: "category",
      data: data.map((r) => dayjs(r.week).format("YYYY-MM-DD")),
    },
    yAxis: { type: "value", name: "issues" },
    series: [
      {
        name: "In SLA",
        key: "in_sla",
        color: theme.palette.success.main,
      },
      {
        name: "Out of SLA, triaged since",
        key: "out_of_sla_triaged",
        color: theme.palette.warning.main,
      },
      {
        name: "Out of SLA, still not triaged",
        key: "out_of_sla_untriaged",
        color: theme.palette.error.main,
      },
      {
        name: `Within the ${SLA_DAYS}-day window`,
        key: "in_window",
        color: theme.palette.info.main,
      },
    ].map((s) => ({
      name: s.name,
      type: "bar",
      stack: "created",
      color: s.color,
      data: data.map((r) => r[s.key as keyof WeeklyRow]),
    })),
  };

  let body;
  if (rows === undefined) {
    body = <Skeleton variant="rectangular" height={CHART_HEIGHT} />;
  } else if (data.length === 0) {
    body = (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4 }}>
        No issues in this range.
      </Typography>
    );
  } else {
    body = (
      <ReactECharts
        option={option}
        notMerge
        theme={theme.palette.mode === "dark" ? "dark-hud" : undefined}
        style={{ height: CHART_HEIGHT, width: "100%" }}
      />
    );
  }

  return (
    <Paper sx={{ p: 2 }} elevation={3}>
      <Typography fontWeight="bold">New issues per week</Typography>
      <Typography variant="caption" color="text.secondary">
        Issues created each week (Monday), by where they stand against the{" "}
        {SLA_DAYS}-day triage SLA. Starts no earlier than {HISTORY_START_DATE}{" "}
        (label history). An issue closed in time and later reopened counts as
        out of SLA.
      </Typography>
      {body}
    </Paper>
  );
}
