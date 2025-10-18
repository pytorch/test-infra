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
  build_url: string;
  steps_table_url: string;
  commit_sha: string;
  build_started_at: string | null; // UTC
  build_finished_at: string | null; // UTC
  duration_hours: number | null;
  steps_count: number;
  latest_build_state: string;
  gpu_1_queue_wait_hours: number;
  gpu_1_queue_run_hours: number;
  gpu_4_queue_wait_hours: number;
  gpu_4_queue_run_hours: number;
  cost: number; // dollars
  is_main_branch: number; // 0/1
};

export default function RunCostPerBuildPanel({
  data,
}: {
  data: Row[] | undefined;
}) {
  const { darkMode } = useDarkMode();
  const [mainOnly, setMainOnly] = useState(true);

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

  // Group rows by pipeline to build one series per pipeline
  const grouped = useMemo(() => {
    const g = new Map<string, Row[]>();
    for (const r of rows) {
      const p = pipelineFromUrl(r.build_url);
      if (!g.has(p)) g.set(p, []);
      g.get(p)!.push(r);
    }
    return g;
  }, [rows]);

  const onPointClick = useCallback((e: any) => {
    const url =
      (e?.data?.value?.[2] as string | undefined) ??
      (e?.value?.[2] as string | undefined) ??
      e?.data?.build_url;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  const option = useMemo(() => {
    const series: any[] = [];
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
          data: mainBuilds.map((r) => ({
            // [0]=ts, [1]=cost, [2]=build_url, [3]=build_number, [4]=pr_url, [5]=is_main, [6]=pipeline, [7]=gpu1_run_h, [8]=gpu4_run_h
            value: [
              r.build_started_at,
              Number(r.cost ?? 0),
              r.build_url ?? null,
              r.build_number ?? null,
              r.pr_url ?? null,
              1,
              pipeline,
              r.gpu_1_queue_run_hours ?? 0,
              r.gpu_4_queue_run_hours ?? 0,
            ],
          })),
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
          data: prBuilds.map((r) => ({
            // [0]=ts, [1]=cost, [2]=build_url, [3]=build_number, [4]=pr_url, [5]=is_main, [6]=pipeline, [7]=gpu1_run_h, [8]=gpu4_run_h
            value: [
              r.build_started_at,
              Number(r.cost ?? 0),
              r.build_url ?? null,
              r.build_number ?? null,
              r.pr_url ?? null,
              0,
              pipeline,
              r.gpu_1_queue_run_hours ?? 0,
              r.gpu_4_queue_run_hours ?? 0,
            ],
          })),
        });
      }
    }

    // CI-only daily average cost (UTC day bucket)
    const acc = new Map<string, { sum: number; count: number }>();
    for (const r of rows) {
      if (pipelineFromUrl(r.build_url) !== "ci") continue;
      const day = (r.build_started_at ?? "").slice(0, 10); // 'YYYY-MM-DD'
      if (!day) continue;
      const val = Number(r.cost ?? 0);
      const cur = acc.get(day) ?? { sum: 0, count: 0 };
      cur.sum += val;
      cur.count += 1;
      acc.set(day, cur);
    }
    const ciDailyAvg = Array.from(acc.entries())
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
    if (ciDailyAvg.length > 0) {
      series.push({
        name: "Daily avg cost",
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
        data: ciDailyAvg,
        z: 3,
      });
    }

    return {
      tooltip: {
        trigger: "item",
        confine: true,
        formatter: (p: any) => {
          // Daily-average line hover
          if (p?.seriesType === "line") {
            const ts = p?.data?.value?.[0] ?? p?.value?.[0];
            const v = Number(p?.data?.value?.[1] ?? p?.value?.[1] ?? 0);
            return `<div><div><b>${
              ts ?? ""
            }</b></div><div>CI daily avg cost: $${v.toFixed(2)}</div></div>`;
          }
          const v = p?.data?.value ?? p?.value ?? [];
          const ts = v[0] ?? "";
          const cost = Number(v[1] ?? 0);
          const url = v[2] as string | null;
          const num = v[3] ?? "—";
          const pr = v[4] as string | null;
          const isM = Number(v[5] ?? 0) === 1;
          const pipe =
            (p?.seriesName as string) || pipelineFromUrl(url ?? null);
          const h1 = Number(v[7] ?? 0);
          const h4 = Number(v[8] ?? 0);
          const c1 = 1.3232 * h1;
          const c4 = 4.602 * h4;
          const total = Number(cost ?? c1 + c4);
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
              <div>Cost GPU1: $${c1.toFixed(2)}</div>
              <div>Cost GPU4: $${c4.toFixed(2)}</div>
              <div>Cost (total): $${total.toFixed(2)}</div>
              <div>Branch: ${isM ? "main" : "PR/other"}</div>
            </div>
          `;
        },
      },
      legend: { top: 0 },
      grid: { left: 40, right: 50, bottom: 40, top: 40 },
      xAxis: { type: "time", name: "Build start (UTC)" },
      yAxis: [{ type: "value", name: "Cost ($)" }],
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
          Run Cost (per build)
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
          tooltip="Build cost per run (compute cost in dollars). Main = circles, PR = triangles. Orange line shows daily average cost for CI pipeline. Click points to view build details."
          option={option}
          onEvents={{ click: onPointClick }}
          darkMode={darkMode}
        />
      </Box>
    </Box>
  );
}
