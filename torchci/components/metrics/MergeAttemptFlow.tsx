import { Box, Paper, Skeleton, Typography } from "@mui/material";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useDarkMode } from "lib/DarkModeContext";
import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import { useMemo } from "react";

interface MergeFlowLinkRow {
  source: string;
  target: string;
  value: number;
  source_depth: number;
  target_depth: number;
}

interface SankeyNode {
  name: string;
  depth: number;
  itemStyle: { color: string };
}

function nodeColor(name: string): string {
  if (name === "Merging PRs") return "#5470c6";
  if (name.startsWith("Landed")) return "#3ba272";
  if (
    name.startsWith("No further attempt") ||
    name.startsWith("Unknown outcome")
  ) {
    return "#8c8c8c";
  }
  if (name.startsWith("More than")) return "#9a60b4";
  if (name.endsWith(": -f")) return "#ee6666";
  if (name.endsWith(": -i")) return "#fac858";
  return "#73c0de";
}

// Fixed locale: the server and the browser must agree or hydration mismatches.
function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export default function MergeAttemptFlow({
  startTime,
  stopTime,
}: {
  startTime: string;
  stopTime: string;
}) {
  const { darkMode } = useDarkMode();
  // Immutable: TimeRangePicker already advances startTime/stopTime every 5
  // minutes, which re-keys the request. A refreshInterval on top of that just
  // doubles the uncached round trips (/api/clickhouse sets use_query_cache=0).
  const { data, error } = useClickHouseAPIImmutable<MergeFlowLinkRow>(
    "merge_attempt_flow",
    { startTime, stopTime }
  );

  const { links, nodes, totalPrs } = useMemo(() => {
    const rows = data ?? [];
    const nodeDepths = new Map<string, number>();

    for (const row of rows) {
      nodeDepths.set(row.source, Number(row.source_depth));
      nodeDepths.set(row.target, Number(row.target_depth));
    }

    const nodes: SankeyNode[] = Array.from(nodeDepths, ([name, depth]) => ({
      name,
      depth,
      itemStyle: { color: nodeColor(name) },
    }));
    const links = rows.map((row) => ({
      source: row.source,
      target: row.target,
      value: Number(row.value),
    }));
    const totalPrs = links
      .filter((link) => link.source === "Merging PRs")
      .reduce((total, link) => total + link.value, 0);

    return { links, nodes, totalPrs };
  }, [data]);

  const options = useMemo<EChartsOption>(
    () => ({
      animationDuration: 400,
      tooltip: {
        trigger: "item",
        formatter: (params: any) => {
          const value = Number(params.value ?? 0);
          const percentage = totalPrs > 0 ? (100 * value) / totalPrs : 0;

          if (params.dataType === "edge") {
            return `${params.data.source} → ${
              params.data.target
            }<br/><strong>${formatCount(
              value
            )} PRs</strong> (${percentage.toFixed(1)}% of cohort)`;
          }

          return `${params.name}<br/><strong>${formatCount(
            value
          )} PRs</strong> (${percentage.toFixed(1)}% of cohort)`;
        },
      },
      series: [
        {
          type: "sankey",
          data: nodes,
          links,
          left: 20,
          right: 190,
          top: 20,
          bottom: 20,
          nodeAlign: "justify",
          nodeGap: 16,
          nodeWidth: 18,
          draggable: false,
          layoutIterations: 32,
          emphasis: { focus: "adjacency" },
          lineStyle: {
            color: "source",
            curveness: 0.5,
            opacity: 0.35,
          },
          label: {
            color: darkMode ? "#e0e0e0" : "#333333",
            fontSize: 12,
            formatter: (params: any) => {
              const value = Number(params.value ?? 0);
              const percentage = totalPrs > 0 ? (100 * value) / totalPrs : 0;
              return `${params.name}\n${formatCount(
                value
              )} (${percentage.toFixed(1)}%)`;
            },
          },
        },
      ],
    }),
    [darkMode, links, nodes, totalPrs]
  );

  if (error) {
    return (
      <Paper sx={{ p: 2 }} elevation={3}>
        <Typography color="error">
          Unable to load merge-attempt data.
        </Typography>
      </Paper>
    );
  }

  if (data === undefined) {
    return <Skeleton variant="rectangular" height={620} />;
  }

  if (data.length === 0) {
    return (
      <Paper sx={{ p: 2 }} elevation={3}>
        <Typography>No completed merge attempts in this time range.</Typography>
      </Paper>
    );
  }

  return (
    <Paper sx={{ p: 2 }} elevation={3}>
      <Typography variant="h6" fontWeight="bold">
        Merge attempt flow
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {formatCount(totalPrs)} PRs <strong>created</strong> in the selected
        range with at least one recorded merge attempt. Paths stop after a
        successful merge; attempts beyond retry 3 are grouped together. Recent
        ranges are incomplete and skew toward first-attempt successes.
      </Typography>
      <Box sx={{ minWidth: 1100, height: 600 }}>
        <ReactECharts
          theme={darkMode ? "dark-hud" : undefined}
          option={options}
          style={{ height: "100%", width: "100%" }}
          notMerge
        />
      </Box>
    </Paper>
  );
}
