import {
  Box,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
} from "@mui/material";
import dayjs from "dayjs";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useDarkMode } from "lib/DarkModeContext";
import React, { useState } from "react";
import {
  getChartTitle,
  getCrosshairTooltipConfig,
  getReactEChartsProps,
  GRID_DEFAULT,
} from "./chartUtils";
import { COLOR_SUCCESS, COLOR_WARNING } from "./constants";

interface JobRuntimeData {
  job_name: string;
  date: string;
  count: number;
  mean_runtime_minutes: number;
  p90_runtime_minutes: number;
  max_runtime_minutes: number;
}

interface JobAggregatedStats {
  job_name: string;
  count: number;
  mean: number;
  p90: number;
  max: number;
}

type SortField = "job_name" | "count" | "mean" | "p90" | "max";
type SortOrder = "asc" | "desc";

// Helper function to aggregate job statistics across all dates
function aggregateJobStats(data: JobRuntimeData[]): JobAggregatedStats[] {
  const jobMap = new Map<string, JobRuntimeData[]>();

  // Group by job name
  data.forEach((row) => {
    if (!jobMap.has(row.job_name)) {
      jobMap.set(row.job_name, []);
    }
    jobMap.get(row.job_name)!.push(row);
  });

  // Aggregate statistics
  const result: JobAggregatedStats[] = [];
  jobMap.forEach((rows, jobName) => {
    const totalCount = rows.reduce((sum, r) => sum + r.count, 0);
    const avgMean =
      rows.reduce((sum, r) => sum + r.mean_runtime_minutes * r.count, 0) /
      totalCount;
    const avgP90 =
      rows.reduce((sum, r) => sum + r.p90_runtime_minutes * r.count, 0) /
      totalCount;
    const overallMax = Math.max(...rows.map((r) => r.max_runtime_minutes));

    result.push({
      job_name: jobName,
      count: totalCount,
      mean: avgMean,
      p90: avgP90,
      max: overallMax,
    });
  });

  return result;
}

// Helper function to format runtime with unit
function formatRuntime(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "-";
  return minutes.toFixed(1) + "m";
}

// Helper function to format tooltip
function formatChartTooltip(params: any): string {
  if (!Array.isArray(params) || params.length === 0) return "";

  const date = params[0].axisValue;
  let result = `<b>${date}</b><br/>`;

  params.forEach((p: any) => {
    if (p.value !== undefined && p.value !== null) {
      result += `${p.marker} ${p.seriesName}: <b>${p.value.toFixed(1)}m</b><br/>`;
    }
  });

  return result;
}

// Helper function to get line chart series
function getLineSeries(
  dates: string[],
  meanData: number[],
  p90Data: number[]
): any[] {
  return [
    {
      name: "Mean Runtime",
      type: "line",
      data: meanData,
      smooth: true,
      symbol: "circle",
      symbolSize: 6,
      itemStyle: { color: COLOR_SUCCESS },
      lineStyle: { width: 2 },
      emphasis: { focus: "series" },
    },
    {
      name: "P90 Runtime",
      type: "line",
      data: p90Data,
      smooth: true,
      symbol: "diamond",
      symbolSize: 7,
      itemStyle: { color: COLOR_WARNING },
      lineStyle: { width: 2, type: "dashed" },
      emphasis: { focus: "series" },
    },
  ];
}

export default function JobRuntimePanel({
  data,
}: {
  data: JobRuntimeData[] | undefined;
}) {
  const { darkMode } = useDarkMode();
  const [sortField, setSortField] = useState<SortField>("mean");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedJob, setSelectedJob] = useState<string | null>(null);

  // Aggregate statistics for the table
  const aggregatedStats = aggregateJobStats(data || []);

  // Filter by search query
  const filteredStats = aggregatedStats.filter((job) =>
    job.job_name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Sort the filtered data
  const sortedStats = [...filteredStats].sort((a, b) => {
    let aValue: number | string = a[sortField];
    let bValue: number | string = b[sortField];

    if (sortField === "job_name") {
      aValue = (aValue as string).toLowerCase();
      bValue = (bValue as string).toLowerCase();
      return sortOrder === "asc"
        ? aValue < bValue
          ? -1
          : 1
        : aValue > bValue
          ? -1
          : 1;
    }

    return sortOrder === "asc"
      ? (aValue as number) - (bValue as number)
      : (bValue as number) - (aValue as number);
  });

  // Auto-select first job if nothing is selected or if selected job is no longer in the list
  React.useEffect(() => {
    if (sortedStats.length > 0) {
      if (!selectedJob || !sortedStats.some((s) => s.job_name === selectedJob)) {
        setSelectedJob(sortedStats[0].job_name);
      }
    }
  }, [sortedStats, selectedJob]);

  // Handle sort request
  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  }

  // Handle row click
  function handleRowClick(jobName: string) {
    setSelectedJob(jobName);
  }

  // Prepare chart data for selected job
  const selectedJobData =
    selectedJob && data
      ? data
          .filter((d) => d.job_name === selectedJob)
          .sort((a, b) => a.date.localeCompare(b.date))
      : [];

  const chartDates = selectedJobData.map((d) =>
    dayjs(d.date).format("MMM D")
  );
  const chartMeanData = selectedJobData.map((d) => d.mean_runtime_minutes);
  const chartP90Data = selectedJobData.map((d) => d.p90_runtime_minutes);

  const chartOptions: EChartsOption = {
    title: {
      text: selectedJob ? "Runtime Trend" : "Select a job to view",
      subtext: selectedJob || "Click a row in the table",
      textStyle: {
        fontSize: 14,
      },
      subtextStyle: {
        fontSize: 16,
        fontWeight: "bold",
        color: darkMode ? "#fff" : "#333",
      },
    },
    legend: {
      top: 40,
      data: ["Mean Runtime", "P90 Runtime"],
    },
    grid: { top: 80, right: 20, bottom: 60, left: 60 },
    xAxis: {
      type: "category",
      data: chartDates,
      name: "Date",
      nameLocation: "middle",
      nameGap: 35,
      axisLabel: {
        rotate: 45,
        fontSize: 10,
      },
    },
    yAxis: {
      type: "value",
      name: "Runtime (minutes)",
      nameLocation: "middle",
      nameGap: 45,
      axisLabel: {
        formatter: (value: number) => `${value}m`,
      },
    },
    series:
      selectedJobData.length > 0
        ? getLineSeries(chartDates, chartMeanData, chartP90Data)
        : [],
    tooltip: getCrosshairTooltipConfig(darkMode, formatChartTooltip),
  };

  return (
    <Paper sx={{ p: 2, height: "100%", overflow: "hidden" }} elevation={3}>
      <Box
        sx={{
          display: "flex",
          flexDirection: { xs: "column", md: "row" },
          gap: 2,
          height: "100%",
        }}
      >
        {/* Table on the left */}
        <Box
          sx={{
            flex: "1 1 50%",
            minWidth: 0,
            maxWidth: "50%",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <TextField
            size="small"
            placeholder="Search jobs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            sx={{ mb: 1 }}
            fullWidth
          />
          <TableContainer sx={{ flex: 1, overflow: "auto" }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>
                    <TableSortLabel
                      active={sortField === "job_name"}
                      direction={sortField === "job_name" ? sortOrder : "asc"}
                      onClick={() => handleSort("job_name")}
                    >
                      Job Name
                    </TableSortLabel>
                  </TableCell>
                  <TableCell align="right">
                    <TableSortLabel
                      active={sortField === "count"}
                      direction={sortField === "count" ? sortOrder : "desc"}
                      onClick={() => handleSort("count")}
                    >
                      Count
                    </TableSortLabel>
                  </TableCell>
                  <TableCell align="right">
                    <TableSortLabel
                      active={sortField === "mean"}
                      direction={sortField === "mean" ? sortOrder : "desc"}
                      onClick={() => handleSort("mean")}
                    >
                      Mean
                    </TableSortLabel>
                  </TableCell>
                  <TableCell align="right">
                    <TableSortLabel
                      active={sortField === "p90"}
                      direction={sortField === "p90" ? sortOrder : "desc"}
                      onClick={() => handleSort("p90")}
                    >
                      P90
                    </TableSortLabel>
                  </TableCell>
                  <TableCell align="right">
                    <TableSortLabel
                      active={sortField === "max"}
                      direction={sortField === "max" ? sortOrder : "desc"}
                      onClick={() => handleSort("max")}
                    >
                      Max
                    </TableSortLabel>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedStats.map((job) => (
                  <TableRow
                    key={job.job_name}
                    hover
                    onClick={() => handleRowClick(job.job_name)}
                    selected={selectedJob === job.job_name}
                    sx={{
                      cursor: "pointer",
                      "&.Mui-selected": {
                        backgroundColor: darkMode
                          ? "rgba(144, 202, 249, 0.16)"
                          : "rgba(25, 118, 210, 0.12)",
                      },
                      "&.Mui-selected:hover": {
                        backgroundColor: darkMode
                          ? "rgba(144, 202, 249, 0.24)"
                          : "rgba(25, 118, 210, 0.18)",
                      },
                    }}
                  >
                    <TableCell sx={{ fontSize: "0.85rem" }}>
                      {job.job_name}
                    </TableCell>
                    <TableCell align="right">{job.count}</TableCell>
                    <TableCell align="right">
                      {formatRuntime(job.mean)}
                    </TableCell>
                    <TableCell align="right">
                      {formatRuntime(job.p90)}
                    </TableCell>
                    <TableCell align="right">
                      {formatRuntime(job.max)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>

        {/* Chart on the right */}
        <Box sx={{ flex: "1 1 50%", minWidth: 0, maxWidth: "50%", overflow: "hidden" }}>
          <ReactECharts
            {...getReactEChartsProps(darkMode)}
            option={chartOptions}
            opts={{ renderer: "canvas", width: "auto", height: "auto" }}
          />
        </Box>
      </Box>
    </Paper>
  );
}
