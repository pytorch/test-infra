import { Box, Chip, Stack, Tooltip, Typography } from "@mui/material";
import { BarChart } from "@mui/x-charts";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import LoadingPage from "components/common/LoadingPage";
import { TextFieldSubmit } from "components/common/TextFieldSubmit";
import { durationDisplay } from "components/common/TimeUtils";
import { encodeParams, fetcher } from "lib/GeneralUtils";
import Link from "next/link";
import { useRouter } from "next/router";
import { useMemo, useState } from "react";
import useSWR from "swr";
import useSWRImmutable from "swr/immutable";

const WORKFLOWS = ["pull", "trunk", "lint"];
const DEFAULT_STATES = ["failed", "skipped"];

// Static per-test duration buckets (seconds), matching the summary query.
const BUCKET_LABELS = [
  "<0.1s",
  "0.1-0.25s",
  "0.25-0.5s",
  "0.5-1s",
  "1-2s",
  "2-3s",
  "3-5s",
  "5-10s",
  "10-20s",
  "20-30s",
  "30-60s",
  "1-2m",
  "2-5m",
  "5m+",
];

const CONCLUSION_COLOR: Record<string, string> = {
  success: "#59a14f",
  failed: "#e15759",
  flaky: "#f28e2c",
  skipped: "#e6c200",
};

interface TestRow {
  invoking_file: string;
  file: string;
  classname: string;
  name: string;
  runs: number;
  time: number;
  median_time: number;
  p90_time: number;
  failures: number;
  errors: number;
  skipped: number;
  reruns: number;
  jobs: string[];
  failed_jobs: string[];
  details: string;
  conclusion: "success" | "failed" | "flaky" | "skipped";
  total_count: number;
}

// Show the full GitHub job name(s) the test ran in: the failing job(s) when
// present, else all of them. First inline, "(+N)" with a tooltip listing the rest.
function JobsCell({ row }: { row: TestRow }) {
  const list = row.failed_jobs?.length ? row.failed_jobs : row.jobs ?? [];
  if (list.length === 0) return <></>;
  const [first, ...rest] = list;
  return (
    <Tooltip title={list.join("\n")}>
      <span>
        {first}
        {rest.length > 0 ? ` (+${rest.length})` : ""}
      </span>
    </Tooltip>
  );
}

interface SummaryRow {
  conclusion: string;
  bucket: number;
  cnt: number;
  executions: number;
}

interface BuildRow {
  workflow: string;
  build: string;
  tests: number;
}

// How many build bars to show in the horizontal distribution.
const TOP_BUILDS = 20;

// Idiomatic pytest node id: "test/<path>.py::<Class>::<test_case>".
// The invoking file is stored as a dotted module (e.g.
// "inductor.test_aot_inductor_arrayref") -- the same convention test_times
// reconstructs paths from -- so dots map to slashes, with a test/ prefix + .py.
// classname may be module-qualified; keep only the final class segment. Tests
// with no class render as "test/<path>.py::<test_case>".
function testNodeId(row: TestRow): string {
  const base = (row.invoking_file || "")
    .replace(/\.py$/, "")
    .replaceAll(".", "/");
  const path = base ? `test/${base}.py` : row.file || "";
  const cls = (row.classname || "").split(".").pop() || "";
  return cls ? `${path}::${cls}::${row.name}` : `${path}::${row.name}`;
}

// The useful line of a traceback is usually the last non-empty one.
function detailsExcerpt(text: string): string {
  if (!text) return "";
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

function ConclusionChip({ conclusion }: { conclusion: string }) {
  return (
    <Chip
      label={conclusion}
      size="small"
      sx={{
        backgroundColor: CONCLUSION_COLOR[conclusion] ?? "grey",
        color: "white",
      }}
    />
  );
}

// Clickable count chip used as the state filter.
function FilterChip({
  label,
  count,
  color,
  active,
  onClick,
}: {
  label: string;
  count: number;
  color: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Chip
      label={`${count} ${label}`}
      onClick={onClick}
      variant={active ? "filled" : "outlined"}
      sx={{
        backgroundColor: active ? color : "transparent",
        color: active ? "white" : "text.primary",
        borderColor: color,
        fontWeight: active ? 700 : 400,
        cursor: "pointer",
      }}
    />
  );
}

export default function Page() {
  const router = useRouter();
  const sha = router.query.sha as string;

  const [states, setStates] = useState<string[]>(DEFAULT_STATES);
  const [nameFilter, setNameFilter] = useState("");
  const [paginationModel, setPaginationModel] = useState({
    page: 0,
    pageSize: 100,
  });

  // Summary (chips + histogram): fetched once per commit, independent of filters.
  const summaryUrl = sha
    ? `/api/clickhouse/viablestrict_run_summary?parameters=${encodeURIComponent(
        JSON.stringify({ sha, workflows: WORKFLOWS })
      )}`
    : null;
  const { data: summary } = useSWRImmutable<SummaryRow[]>(summaryUrl, fetcher);

  // Tests-per-build distribution (also once per commit).
  const buildsUrl = sha
    ? `/api/clickhouse/viablestrict_run_workflows?parameters=${encodeURIComponent(
        JSON.stringify({ sha, workflows: WORKFLOWS })
      )}`
    : null;
  const { data: builds } = useSWRImmutable<BuildRow[]>(buildsUrl, fetcher);

  // Paginated, filtered table.
  const tableUrl = sha
    ? `/api/clickhouse/viablestrict_run_tests?parameters=${encodeURIComponent(
        JSON.stringify({
          sha,
          workflows: WORKFLOWS,
          states,
          sort: "duration",
          name_filter: nameFilter ? `%${nameFilter}%` : "%",
          limit: paginationModel.pageSize,
          offset: paginationModel.page * paginationModel.pageSize,
        })
      )}`
    : null;
  const { data, isLoading } = useSWR<TestRow[]>(tableUrl, fetcher, {
    keepPreviousData: true,
  });

  const rows = data ?? [];
  const rowCount = rows[0]?.total_count ?? 0;

  // Derive chip totals, histogram, and execution totals from the summary.
  const { counts, histogram, executions } = useMemo(() => {
    const counts: Record<string, number> = {
      success: 0,
      failed: 0,
      skipped: 0,
      flaky: 0,
    };
    const histogram = new Array(BUCKET_LABELS.length).fill(0);
    let executions = 0;
    for (const r of summary ?? []) {
      counts[r.conclusion] = (counts[r.conclusion] ?? 0) + r.cnt;
      executions += r.executions ?? 0;
      if (r.bucket >= 0 && r.bucket < histogram.length) {
        histogram[r.bucket] += r.cnt;
      }
    }
    return { counts, histogram, executions };
  }, [summary]);

  const distinctTests =
    counts.success + counts.failed + counts.skipped + counts.flaky;

  // Top-N builds for the horizontal distribution chart (already sorted desc).
  const buildBars = (builds ?? []).slice(0, TOP_BUILDS);
  const buildLabels = buildBars.map((b) => `${b.workflow} / ${b.build}`);
  const buildValues = buildBars.map((b) => b.tests);

  // Clicking a chip drills into that single state; clicking the active sole
  // state resets to the default (failed + skipped).
  function pickState(s: string) {
    setStates((prev) =>
      prev.length === 1 && prev[0] === s ? DEFAULT_STATES : [s]
    );
    setPaginationModel((m) => ({ ...m, page: 0 }));
  }

  const columns: GridColDef[] = [
    {
      field: "conclusion",
      headerName: "Status",
      width: 90,
      sortable: false,
      renderCell: (params) => <ConclusionChip conclusion={params.value} />,
    },
    {
      field: "name",
      headerName: "Test",
      flex: 3,
      sortable: false,
      renderCell: (params) => {
        const row = params.row as TestRow;
        const id = testNodeId(row);
        const href = `/tests/testInfo?${encodeParams({
          name: row.name,
          suite: row.classname,
          file: row.file,
        })}`;
        return (
          <Tooltip title={id}>
            <Link href={href}>{id}</Link>
          </Tooltip>
        );
      },
    },
    {
      field: "jobs",
      headerName: "Workflow / Job",
      flex: 2,
      sortable: false,
      renderCell: (params) => <JobsCell row={params.row as TestRow} />,
    },
    {
      field: "runs",
      headerName: "Runs",
      width: 80,
      type: "number",
      sortable: false,
      description:
        "Number of config/platform jobs the test ran in (shards and re-run attempts collapsed)",
    },
    {
      field: "time",
      headerName: "Total dur",
      description: "Total time across all of this test's config runs",
      width: 100,
      type: "number",
      sortable: false,
      valueFormatter: (value: number) => durationDisplay(value),
    },
    {
      field: "median_time",
      headerName: "Median",
      description: "Median duration of a single run of this test",
      width: 90,
      type: "number",
      sortable: false,
      valueFormatter: (value: number) => durationDisplay(value),
    },
    {
      field: "p90_time",
      headerName: "P90",
      description: "90th-percentile duration of a single run of this test",
      width: 90,
      type: "number",
      sortable: false,
      valueFormatter: (value: number) => durationDisplay(value),
    },
    {
      field: "details",
      headerName: "Details",
      flex: 3,
      sortable: false,
      renderCell: (params) => {
        const text = (params.value as string) ?? "";
        if (!text) return <></>;
        return (
          <Tooltip title={<pre style={{ whiteSpace: "pre-wrap" }}>{text}</pre>}>
            <span>{detailsExcerpt(text)}</span>
          </Tooltip>
        );
      },
    },
    {
      field: "reruns",
      headerName: "Retries",
      width: 80,
      type: "number",
      sortable: false,
    },
  ];

  if (!router.isReady) {
    return <LoadingPage />;
  }

  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Typography variant="h4">
        viable/strict test run{" "}
        <Link href={`/hud/pytorch/pytorch/${sha}`}>{sha?.slice(0, 7)}</Link>
      </Typography>

      <Typography variant="subtitle2" color="text.secondary">
        Total Test Time Distribution (summed across all configs)
      </Typography>
      <Box sx={{ width: "100%" }}>
        <BarChart
          height={220}
          xAxis={[{ data: BUCKET_LABELS, scaleType: "band" }]}
          series={[{ data: histogram, label: "tests", color: "#59a14f" }]}
        />
      </Box>

      <Typography variant="subtitle2" color="text.secondary">
        Test coverage by build, top {buildBars.length}
        {(builds?.length ?? 0) > buildBars.length
          ? ` of ${builds?.length}`
          : ""}{" "}
        (workflow / build)
      </Typography>
      <Box sx={{ width: "100%" }}>
        <BarChart
          layout="horizontal"
          height={Math.max(160, buildBars.length * 26 + 60)}
          yAxis={[{ scaleType: "band", data: buildLabels, width: 320 }]}
          series={[{ data: buildValues, label: "tests", color: "#4e79a7" }]}
          barLabel="value"
        />
      </Box>

      <Typography variant="subtitle2" color="text.secondary">
        Distinct Test Status — {distinctTests.toLocaleString()} unique tests
        (one per name/suite/file), de-duplicated across configs, from{" "}
        {executions.toLocaleString()} executions across configs.
      </Typography>
      <Box
        sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center" }}
      >
        <FilterChip
          label="passed"
          count={counts.success}
          color={CONCLUSION_COLOR.success}
          active={states.length === 1 && states[0] === "success"}
          onClick={() => pickState("success")}
        />
        <FilterChip
          label="failed"
          count={counts.failed}
          color={CONCLUSION_COLOR.failed}
          active={states.includes("failed")}
          onClick={() => pickState("failed")}
        />
        <FilterChip
          label="skipped"
          count={counts.skipped}
          color={CONCLUSION_COLOR.skipped}
          active={states.includes("skipped")}
          onClick={() => pickState("skipped")}
        />
        <FilterChip
          label="flaky"
          count={counts.flaky}
          color={CONCLUSION_COLOR.flaky}
          active={states.length === 1 && states[0] === "flaky"}
          onClick={() => pickState("flaky")}
        />
        <Box sx={{ flexGrow: 1 }} />
        <TextFieldSubmit
          textFieldValue={nameFilter}
          onSubmit={(v) => {
            setNameFilter(v);
            setPaginationModel((m) => ({ ...m, page: 0 }));
          }}
          info={"Search for Test"}
        />
      </Box>

      <Typography variant="body2" color="text.secondary">
        Showing {rowCount} tests (states: {states.join(", ")}). Default view is
        failed + skipped; click a chip to drill in.
      </Typography>

      <div style={{ height: "65vh", width: "100%" }}>
        {isLoading && rows.length === 0 ? (
          <LoadingPage />
        ) : (
          <DataGrid
            rows={rows}
            columns={columns}
            density="compact"
            getRowId={(row) =>
              `${row.invoking_file}-${row.classname}-${row.name}`
            }
            paginationMode="server"
            rowCount={rowCount}
            paginationModel={paginationModel}
            onPaginationModelChange={setPaginationModel}
            pageSizeOptions={[50, 100, 250]}
            loading={isLoading}
          />
        )}
      </div>
    </Stack>
  );
}
