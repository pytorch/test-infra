import { Box, Stack, Switch, Tooltip, Typography } from "@mui/material";
import { useDarkMode } from "lib/DarkModeContext";
import { useCallback, useMemo, useState } from "react";
import { ChartPaper } from "./chartUtils";

// Helper: extract pipeline slug from Buildkite URL (e.g., /vllm/ci/builds/...)
function pipelineFromUrl(url: string | null): string {
  try {
    if (!url) return "unknown";
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    // ['', 'vllm', 'ci', 'builds', '35431', ...] => ['vllm','ci','builds','35431'] -> 'ci'
    return (parts[1] || "unknown").toLowerCase();
  } catch {
    const m = url?.match(/buildkite\.com\/[^/]+\/([^/]+)/i);
    return (m?.[1] ?? "unknown").toLowerCase();
  }
}

type Row = {
  pr_url: string | null;
  build_number: number;
  build_id: string;
  build_url: string | null; // may be NULL in ClickHouse
  steps_table_url: string | null; // SQL always builds this
  commit_sha: string;
  build_started_at: string | null; // UTC
  build_finished_at: string | null; // UTC
  duration_hours: number | null;
  steps_count: number;
  latest_build_state: string;

  // P90 wait columns
  wait_p90_hours: number;
  gpu_1_queue_wait_p90_hours: number;
  gpu_4_queue_wait_p90_hours: number;
  cpu_queue_wait_p90_hours: number;

  is_main_branch: number; // 0/1
};

export default function QueueWaitPerBuildPanel({
  data,
}: {
  data: Row[] | undefined;
}) {
  const { darkMode } = useDarkMode();
  const [mainOnly, setMainOnly] = useState(true);

  // Filter & sort; drop rows without a start time (time axis needs x)
  const rows = useMemo(() => {
    const r = (data ?? [])
      .filter((x) => (mainOnly ? x.is_main_branch === 1 : true))
      .filter((x) => !!x.build_started_at);

    return r.sort((a, b) => {
      const ta = a.build_started_at
        ? new Date(a.build_started_at).getTime()
        : 0;
      const tb = b.build_started_at
        ? new Date(b.build_started_at).getTime()
        : 0;
      return ta - tb || a.build_number - b.build_number;
    });
  }, [data, mainOnly]);

  // Group rows by pipeline, but derive pipeline from the *link url* (build_url || steps_table_url)
  const grouped = useMemo(() => {
    const g = new Map<string, Row[]>();
    for (const r of rows) {
      const linkUrl = r.build_url || r.steps_table_url || null;
      const p = pipelineFromUrl(linkUrl);
      if (!g.has(p)) g.set(p, []);
      g.get(p)!.push(r);
    }
    return g;
  }, [rows]);

  // Click → open Buildkite (always read from data.link we attach below)
  const onPointClick = useCallback((p: any) => {
    const url: string | null =
      p?.data?.link ?? p?.data?.build_url ?? p?.data?.row?.build_url ?? null;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  const option = useMemo(() => {
    const series: any[] = [];

    // Build scatter series per pipeline, split by main vs PR
    // We pass each point as an OBJECT (not array) so tooltip/click
    // can read stable fields regardless of how ECharts wraps values.
    for (const [pipeline, arr] of grouped.entries()) {
      // Skip release pipeline (all zeros)
      if (pipeline === "release") continue;

      // Split into main and PR builds
      const mainBuilds = arr.filter((r) => Number(r.is_main_branch ?? 0) === 1);
      const prBuilds = arr.filter((r) => Number(r.is_main_branch ?? 0) !== 1);

      // Main branch builds - circles
      if (mainBuilds.length > 0) {
        series.push({
          name: `${pipeline} (main)`,
          type: "scatter",
          symbol: "circle",
          symbolSize: 6,
          cursor: "pointer",
          data: mainBuilds.map((r) => {
            const link = r.build_url || r.steps_table_url || null;
            return {
              // ECharts uses value[0] for x and value[1] for y on a scatter
              // Convert hours to minutes for display
              value: [r.build_started_at, Number(r.wait_p90_hours ?? 0) * 60],
              link, // <— used for click and pipeline fallback
              bn: r.build_number ?? null,
              pr: r.pr_url ?? null,
              main: true,
              w1: Number(r.gpu_1_queue_wait_p90_hours ?? 0) * 60,
              w4: Number(r.gpu_4_queue_wait_p90_hours ?? 0) * 60,
              wc: Number(r.cpu_queue_wait_p90_hours ?? 0) * 60,
            };
          }),
        });
      }

      // PR builds - triangles (only show if mainOnly is off)
      if (!mainOnly && prBuilds.length > 0) {
        series.push({
          name: `${pipeline} (PR)`,
          type: "scatter",
          symbol: "triangle",
          symbolSize: 7,
          cursor: "pointer",
          data: prBuilds.map((r) => {
            const link = r.build_url || r.steps_table_url || null;
            return {
              // ECharts uses value[0] for x and value[1] for y on a scatter
              // Convert hours to minutes for display
              value: [r.build_started_at, Number(r.wait_p90_hours ?? 0) * 60],
              link, // <— used for click and pipeline fallback
              bn: r.build_number ?? null,
              pr: r.pr_url ?? null,
              main: false,
              w1: Number(r.gpu_1_queue_wait_p90_hours ?? 0) * 60,
              w4: Number(r.gpu_4_queue_wait_p90_hours ?? 0) * 60,
              wc: Number(r.cpu_queue_wait_p90_hours ?? 0) * 60,
            };
          }),
        });
      }
    }

    // Calculate daily average P90 wait time (CI pipeline only)
    const dailyAvg = new Map<string, { sum: number; count: number }>();
    for (const r of rows) {
      const linkUrl = r.build_url || r.steps_table_url || null;
      const pipeline = pipelineFromUrl(linkUrl);
      if (pipeline !== "ci") continue; // Only include CI pipeline
      const day = (r.build_started_at ?? "").slice(0, 10); // 'YYYY-MM-DD'
      if (!day) continue;
      const val = Number(r.wait_p90_hours ?? 0) * 60; // Convert to minutes
      const cur = dailyAvg.get(day) ?? { sum: 0, count: 0 };
      cur.sum += val;
      cur.count += 1;
      dailyAvg.set(day, cur);
    }

    const dailyAvgData = Array.from(dailyAvg.entries())
      .map(([day, { sum, count }]) => ({
        value: [
          new Date(`${day}T12:00:00Z`).toISOString(), // Midday for centering
          sum / Math.max(1, count),
        ],
      }))
      .sort(
        (a, b) =>
          Date.parse(String(a.value[0])) - Date.parse(String(b.value[0]))
      );

    if (dailyAvgData.length > 0) {
      series.push({
        name: "Daily avg P90",
        type: "line",
        symbol: "circle",
        symbolSize: 6,
        itemStyle: {
          color: "#ff7f0e",
          borderColor: "#ff7f0e",
          borderWidth: 2,
        },
        lineStyle: {
          width: 2,
          color: "#ff7f0e",
        },
        emphasis: { focus: "series" },
        data: dailyAvgData,
        z: 3,
      });
    }

    return {
      tooltip: {
        trigger: "item",
        confine: true,
        formatter: (p: any) => {
          const d = p?.data ?? {};
          const ts = d?.value?.[0] ?? "";
          const y = Number(d?.value?.[1] ?? 0);
          const url: string | null = d?.link ?? null;
          const num = d?.bn ?? "—";
          const pr: string | null = d?.pr ?? null;
          const isM: boolean = !!d?.main;
          const w1 = Number(d?.w1 ?? 0);
          const w4 = Number(d?.w4 ?? 0);
          const wc = Number(d?.wc ?? 0);
          const pipe = (p?.seriesName as string) || pipelineFromUrl(url);

          const buildLink = url
            ? `<a href="${url}" target="_blank" rel="noreferrer">#${num}</a>`
            : `#${num}`;
          const prLine = pr
            ? `<div>PR: <a href="${pr}" target="_blank" rel="noreferrer">${pr
                .replace("https://github.com/", "")
                .replace("/pull/", "#")}</a></div>`
            : "";

          return `
            <div>
              <div><b>${ts}</b></div>
              <div>Pipeline: <b>${pipe}</b></div>
              <div>Build: ${buildLink}</div>
              ${prLine}
              <div>P90 wait GPU1: ${w1.toFixed(1)} min</div>
              <div>P90 wait GPU4: ${w4.toFixed(1)} min</div>
              <div>P90 wait CPU: ${wc.toFixed(1)} min</div>
              <div>P90 wait (combined): ${y.toFixed(1)} min</div>
              <div>Branch: ${isM ? "main" : "PR/other"}</div>
            </div>
          `;
        },
      },
      legend: { top: 0 },
      grid: { left: 40, right: 50, bottom: 40, top: 40 },
      xAxis: { type: "time", name: "Build start (UTC)" },
      yAxis: [{ type: "value", name: "P90 Wait (min)" }],
      series,
    };
  }, [grouped, mainOnly, rows]);

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        sx={{ px: 2, pt: 1 }}
      >
        <Typography variant="h6" sx={{ fontWeight: "bold" }}>
          Queue Wait (per build)
        </Typography>
        <Tooltip title="Show only builds on branch 'main'">
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body2">Main only</Typography>
            <Switch
              size="small"
              checked={mainOnly}
              onChange={() => setMainOnly((s) => !s)}
            />
          </Stack>
        </Tooltip>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 240 }}>
        <ChartPaper
          key={mainOnly ? "main-only" : "all-branches"}
          tooltip="P90 queue wait time per build (how long jobs waited in queue before starting). Main = circles, PR = triangles. Orange line shows daily average for CI pipeline. Click points to view build details."
          option={option}
          onEvents={{ click: onPointClick }}
          darkMode={darkMode}
        />
      </Box>
    </Box>
  );
}
