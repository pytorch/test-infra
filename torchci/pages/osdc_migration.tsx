/**
 * OSDC migration tracker.
 *
 * Shows, per repo, how much of its CI still runs on the legacy Lambda-autoscaled
 * EC2 fleet versus OSDC (ARC on EKS), broken down by workflow file so a repo
 * owner has a concrete checklist rather than a percentage.
 *
 * How a file is judged: every job it ran in the window is bucketed by the runner
 * that actually executed it -- an EC2 instance id means legacy, an OSDC cluster
 * runner group means migrated. See clickhouse_queries/osdc_migration_by_file.
 *
 * Two deliberate scoping choices, both surfaced in the UI rather than hidden:
 *  - Only Linux counts. Windows and macOS have no ARC runners yet, so including
 *    them would cap every repo below 100% forever.
 *  - ClickHouse only sees files that ran. The real file list comes from the repo
 *    tree, so files with no recent CI show up as "not run" instead of vanishing.
 */
import {
  Box,
  Checkbox,
  Chip,
  FormControl,
  FormControlLabel,
  InputLabel,
  ListSubheader,
  MenuItem,
  Paper,
  Select,
  SelectChangeEvent,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { GridColDef, GridRenderCellParams } from "@mui/x-data-grid";
import { ScalarPanelWithValue } from "components/metrics/panels/ScalarPanel";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import dayjs from "dayjs";
import { fetcher } from "lib/GeneralUtils";
import { useEffect, useState } from "react";
import useSWR from "swr";

const REPOS = [
  "pytorch/executorch",
  "pytorch/helion",
  "pytorch/FBGEMM",
  "pytorch/vision",
  "pytorch/torchtitan",
  "pytorch/ao",
];

// pytorch/pytorch is the reference: it finished this migration, so it shows what
// "done" looks like. It is not comparable to the repos above -- it reaches OSDC
// through runtime label translation (.github/arc.yaml + map_ec2_to_arc.py) rather
// than by editing runs-on, so its source YAML still reads as EC2.
const REFERENCE_REPOS = ["pytorch/pytorch"];

const ROW_HEIGHT = 240;

// The Daily hits column draws one bar per day, so a longer window turns it into
// an unreadable smear. Cap the picker rather than making the column adaptive:
// migration state is a "what is true right now" question, not a trend, and the
// shared TimeRangePicker can't be capped without changing it for /metrics too.
const TIME_RANGES = [1, 3, 7, 14];

type Status =
  | "unmigrated"
  | "partial"
  | "migrated"
  | "out_of_scope"
  | "not_run";

type FileRow = {
  workflowFile: string;
  legacyJobs: number;
  osdcJobs: number;
  otherJobs: number;
  legacyMainline: number;
  osdcMainline: number;
  legacyLabels: string[];
  legacyByDay: number[];
  legacyMainlineByDay: number[];
  lastLegacyRun: string;
  lastLegacyMainlineRun: string;
  lastRun: string;
  legacyShare: number;
  status: Status;
};

/**
 * Single source of truth for the verdict. The page derives it rather than using
 * the query's `status` column, because the exclude-PR-scoped toggle has to be
 * able to recompute it from a different pair of counters.
 */
function deriveStatus(legacy: number, osdc: number): Status {
  if (legacy === 0 && osdc === 0) return "out_of_scope";
  if (legacy === 0) return "migrated";
  if (osdc === 0) return "unmigrated";
  return "partial";
}

const STATUS_LABEL: { [k: string]: string } = {
  unmigrated: "Unmigrated",
  partial: "Partial",
  migrated: "Migrated",
  out_of_scope: "Nothing to migrate",
  not_run: "Not run in window",
};

/** Compact chip geometry that fits a dense table row. */
const CHIP_SX = {
  height: 20,
  fontSize: "0.7rem",
  "& .MuiChip-label": { px: 1 },
};

function StatusChip({ status }: { status: string }) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  // [background, foreground] per mode. Only the three states a repo owner can act
  // on get a fill; "Nothing to migrate" and "Not run" are outlined so the eye
  // skips them -- in a migrated repo they are most of the rows.
  const filled: { [k: string]: [string, string] } = {
    unmigrated: dark ? ["#5c2b2b", "#ffb4b4"] : ["#fdecea", "#a12622"],
    partial: dark ? ["#5a4520", "#ffcc80"] : ["#fff3e0", "#a15c00"],
    migrated: dark ? ["#22432c", "#a5d6a7"] : ["#e8f5e9", "#1b5e20"],
  };
  const label = STATUS_LABEL[status] ?? status;
  const fill = filled[status];
  if (fill === undefined) {
    return (
      <Chip
        size="small"
        variant="outlined"
        label={label}
        sx={{
          ...CHIP_SX,
          opacity: 0.6,
          borderColor: dark ? "#4a4a4a" : "#d5d5d5",
        }}
      />
    );
  }
  return (
    <Chip
      size="small"
      label={label}
      sx={{
        ...CHIP_SX,
        backgroundColor: fill[0],
        color: fill[1],
        fontWeight: 600,
      }}
    />
  );
}

/**
 * "2h ago" / "6d ago" -- short enough for a table cell.
 *
 * Returns null when there is no legacy job to date: the query's maxIf yields the
 * epoch for files that never touched EC2, which must not render as "20000d ago".
 */
function relativeAge(iso: string, now: dayjs.Dayjs): string | null {
  if (!iso) return null;
  const t = dayjs(iso);
  if (!t.isValid() || t.year() < 2000) return null;
  const mins = now.diff(t, "minute");
  if (mins < 60) return `${Math.max(mins, 1)}m ago`;
  const hours = now.diff(t, "hour");
  if (hours < 48) return `${hours}h ago`;
  return `${now.diff(t, "day")}d ago`;
}

/** Tiny inline bar chart of legacy jobs per day, oldest on the left. */
function DailyHits({ counts }: { counts: number[] }) {
  const theme = useTheme();
  if (!counts || counts.length === 0) {
    return <span style={{ opacity: 0.4 }}>—</span>;
  }
  // query returns index 0 = most recent day; render chronologically
  const series = [...counts].reverse();
  const max = Math.max(...series, 1);
  const total = series.reduce((a, b) => a + b, 0);
  return (
    <Tooltip
      title={`${total.toLocaleString()} legacy jobs: ${series.join(", ")}`}
    >
      <Box
        sx={{ display: "flex", alignItems: "flex-end", gap: "2px", height: 22 }}
      >
        {series.map((c, i) => (
          <Box
            key={i}
            sx={{
              width: 6,
              height: Math.max(2, Math.round((c / max) * 20)),
              backgroundColor:
                c === 0
                  ? theme.palette.mode === "dark"
                    ? "#3a3a3a"
                    : "#e0e0e0"
                  : "#ee6666",
              borderRadius: "1px",
            }}
          />
        ))}
      </Box>
    </Tooltip>
  );
}

export default function Page() {
  const [repo, setRepo] = useState<string>(REPOS[0]);
  const [days, setDays] = useState<number>(7);
  const [excludePrScoped, setExcludePrScoped] = useState(false);

  // Slide the window forward every 5 minutes so a left-open tab keeps showing
  // "the last N days" rather than freezing at page load.
  const [now, setNow] = useState(() => dayjs());
  useEffect(() => {
    const id = setInterval(() => setNow(dayjs()), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const timeParams = {
    startTime: now
      .subtract(days, "day")
      .utc()
      .format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: now.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
  };

  const observedUrl = `/api/clickhouse/osdc_migration_by_file?parameters=${encodeURIComponent(
    JSON.stringify({ ...timeParams, repo })
  )}`;
  const { data: observed } = useSWR<FileRow[]>(observedUrl, fetcher, {
    refreshInterval: 5 * 60 * 1000,
  });

  // Real file list from the repo tree -- the denominator ClickHouse cannot supply.
  // If this fails (app not installed on the repo, GitHub down) the page still
  // works off observed files alone, but it is then undercounting, so say so.
  const { data: tree, error: treeError } = useSWR<{ files: string[] }>(
    `/api/osdc_migration/workflow_files?repo=${encodeURIComponent(repo)}`,
    fetcher
  );
  const treeUnavailable = treeError !== undefined || tree?.files === undefined;

  const loading = observed === undefined;

  // Union the observed rows with the files that exist but did not run.
  const observedByFile = new Map(
    (observed ?? []).map((r) => [r.workflowFile, r])
  );
  const notRun: FileRow[] = (tree?.files ?? [])
    .filter((f) => !observedByFile.has(f))
    .map((f) => ({
      workflowFile: f,
      legacyJobs: 0,
      osdcJobs: 0,
      otherJobs: 0,
      legacyMainline: 0,
      osdcMainline: 0,
      legacyLabels: [],
      legacyByDay: [],
      legacyMainlineByDay: [],
      lastLegacyRun: "",
      lastLegacyMainlineRun: "",
      lastRun: "",
      legacyShare: 0,
      status: "not_run" as const,
    }));

  // Fold the active view's counters into the fields the table renders, so the
  // column definitions stay view-agnostic.
  const rows: FileRow[] = [...(observed ?? []), ...notRun].map((r) => {
    if (!excludePrScoped || r.status === "not_run") {
      return r;
    }
    const legacy = r.legacyMainline;
    const osdc = r.osdcMainline;
    return {
      ...r,
      legacyJobs: legacy,
      osdcJobs: osdc,
      legacyByDay: r.legacyMainlineByDay,
      lastLegacyRun: r.lastLegacyMainlineRun,
      legacyShare: legacy + osdc === 0 ? 0 : legacy / (legacy + osdc),
      status: deriveStatus(legacy, osdc),
    };
  });

  const unmigrated = rows.filter((r) => r.status === "unmigrated");
  const partial = rows.filter((r) => r.status === "partial");
  const migrated = rows.filter((r) => r.status === "migrated");
  // Denominator is files that ran something OSDC could take. "Nothing to migrate"
  // and "Not run" are excluded -- counting them would make the number unmovable.
  const scoped = unmigrated.length + partial.length + migrated.length;
  const pct = scoped === 0 ? undefined : migrated.length / scoped;
  const legacyJobTotal = rows.reduce((a, r) => a + r.legacyJobs, 0);
  const osdcJobTotal = rows.reduce((a, r) => a + r.osdcJobs, 0);
  // Job share moves long before file share does: a repo can be 79% of files but
  // 99.97% of jobs, which means only stragglers are left. Showing both makes that
  // visible instead of hiding it behind one number.
  const jobPct =
    legacyJobTotal + osdcJobTotal === 0
      ? undefined
      : osdcJobTotal / (legacyJobTotal + osdcJobTotal);

  const columns: GridColDef[] = [
    {
      field: "workflowFile",
      headerName: "Workflow file",
      flex: 1,
      minWidth: 320,
      renderCell: (params: GridRenderCellParams) => (
        <a
          href={`https://github.com/${repo}/blob/HEAD/${params.value}`}
          target="_blank"
          rel="noreferrer"
          style={{ fontFamily: "monospace", fontSize: "0.8rem" }}
        >
          {String(params.value).replace(".github/workflows/", "")}
        </a>
      ),
    },
    {
      field: "status",
      headerName: "Migration status",
      width: 180,
      renderCell: (params: GridRenderCellParams) => (
        <Stack
          direction="row"
          spacing={0.5}
          alignItems="center"
          sx={{ height: "100%" }}
        >
          <StatusChip status={params.value} />
        </Stack>
      ),
    },
    // Keep the two absolute counts adjacent and right after the status: the
    // legacy-vs-OSDC comparison is the whole point, and the derived % reads as a
    // summary of the pair immediately to its left.
    {
      field: "legacyJobs",
      headerName: "Legacy jobs",
      width: 110,
      type: "number",
      valueFormatter: (value: number) =>
        value === 0 ? "—" : value.toLocaleString(),
    },
    {
      field: "osdcJobs",
      headerName: "OSDC jobs",
      width: 105,
      type: "number",
      valueFormatter: (value: number) =>
        value === 0 ? "—" : value.toLocaleString(),
    },
    {
      field: "legacyShare",
      headerName: "% legacy",
      width: 95,
      type: "number",
      valueFormatter: (value: number, row: FileRow) =>
        row.status === "migrated" || row.status === "not_run"
          ? "—"
          : // don't round a real straggler down to a clean 0%
            (value * 100).toFixed(value > 0 && value < 0.001 ? 3 : 1) + "%",
    },
    // Recency of the last legacy job, shown rather than folded into the status.
    // A short-window rule that auto-promoted quiet files to "Migrated" flapped
    // badly on intermittent stragglers, so surface the evidence and let the
    // reader judge: "6d ago" is finished, "2h ago" is still leaking.
    {
      field: "lastLegacyRun",
      headerName: "Last legacy job",
      width: 130,
      renderCell: (params: GridRenderCellParams) => {
        const age = relativeAge(params.value, now);
        if (age === null) return <span style={{ opacity: 0.4 }}>—</span>;
        return (
          <Tooltip title={dayjs(params.value).format("YYYY-MM-DD HH:mm:ss")}>
            <span>{age}</span>
          </Tooltip>
        );
      },
    },
    {
      field: "legacyByDay",
      headerName: "Daily hits",
      width: 110,
      sortable: false,
      renderCell: (params: GridRenderCellParams) => (
        <Stack justifyContent="center" sx={{ height: "100%" }}>
          <DailyHits counts={params.value} />
        </Stack>
      ),
    },
    {
      field: "legacyLabels",
      headerName: "Legacy runner labels",
      flex: 1,
      minWidth: 260,
      sortable: false,
      renderCell: (params: GridRenderCellParams) => {
        const labels: string[] = params.value ?? [];
        if (labels.length === 0) return <span style={{ opacity: 0.4 }}>—</span>;
        return (
          <Tooltip title={labels.join(", ")}>
            <span style={{ fontFamily: "monospace", fontSize: "0.75rem" }}>
              {labels.join(", ")}
            </span>
          </Tooltip>
        );
      },
    },
  ];

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }} alignItems="center">
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          OSDC Migration
        </Typography>
        <FormControl>
          <InputLabel id="osdc-repo-label">Repo</InputLabel>
          <Select
            defaultValue={REPOS[0]}
            label="Repo"
            labelId="osdc-repo-label"
            onChange={(e: SelectChangeEvent<string>) =>
              setRepo(e.target.value as string)
            }
            id="osdc-repo-picker"
            value={repo}
            size="small"
          >
            {REPOS.map((r) => (
              <MenuItem key={r} value={r}>
                {r}
              </MenuItem>
            ))}
            <ListSubheader>Reference (already migrated)</ListSubheader>
            {REFERENCE_REPOS.map((r) => (
              <MenuItem key={r} value={r}>
                {r}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl>
          <InputLabel id="osdc-range-label">Time Range</InputLabel>
          <Select
            label="Time Range"
            labelId="osdc-range-label"
            id="osdc-range-picker"
            value={days}
            onChange={(e: SelectChangeEvent<number>) =>
              setDays(Number(e.target.value))
            }
            size="small"
          >
            {TIME_RANGES.map((d) => (
              <MenuItem key={d} value={d}>
                Last {d} {d === 1 ? "Day" : "Days"}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Tooltip
          title={
            "Drop pull_request runs and ciflow/* tag pushes. Those execute the workflow " +
            "definition from the PR branch, so a long-lived branch keeps replaying " +
            "pre-migration YAML after main is already clean. Default-branch pushes, nightly, " +
            "release tags and schedules are kept — they run the current definition."
          }
        >
          <FormControlLabel
            control={
              <Checkbox
                checked={excludePrScoped}
                onChange={(e) => setExcludePrScoped(e.target.checked)}
                size="small"
              />
            }
            label="Exclude PR-scoped runs"
          />
        </Tooltip>
      </Stack>

      <Stack
        direction="row"
        spacing={2}
        sx={{ mb: 2 }}
        height={ROW_HEIGHT / 1.6}
      >
        <Box sx={{ flex: 1 }}>
          <ScalarPanelWithValue
            title={"% of files migrated"}
            value={loading ? undefined : pct}
            valueRenderer={(v) =>
              v === undefined ? "n/a" : (v * 100).toFixed(0) + "%"
            }
            badThreshold={(v) => v !== undefined && v < 0.5}
          />
        </Box>
        <Box sx={{ flex: 1 }}>
          <ScalarPanelWithValue
            title={"Files migrated / in scope"}
            value={loading ? undefined : `${migrated.length}/${scoped}`}
            valueRenderer={(v) => String(v)}
            badThreshold={() => false}
          />
        </Box>
        <Box sx={{ flex: 1 }}>
          <ScalarPanelWithValue
            title={"% of jobs on OSDC"}
            value={loading ? undefined : jobPct}
            valueRenderer={(v) =>
              v === undefined ? "n/a" : (v * 100).toFixed(1) + "%"
            }
            badThreshold={(v) => v !== undefined && v < 0.5}
          />
        </Box>
        <Box sx={{ flex: 1 }}>
          <ScalarPanelWithValue
            title={"Jobs still on legacy EC2"}
            value={loading ? undefined : legacyJobTotal}
            valueRenderer={(v) => Number(v).toLocaleString()}
            badThreshold={(v) => v > 0}
          />
        </Box>
      </Stack>

      {partial.length > 0 && (
        <Typography variant="caption" sx={{ display: "block", mb: 1 }}>
          <b>{partial.length}</b>{" "}
          {partial.length === 1 ? "file has" : "files have"} jobs on both
          fleets. Sort by <b>% legacy</b> to separate real work from stragglers
          — a file at 0.03% is one leaked job, not an unmigrated workflow.
        </Typography>
      )}

      <Paper sx={{ p: 1, mb: 2 }} elevation={3}>
        <Box sx={{ height: 620 }}>
          <TablePanelWithData
            title={`${repo} — workflow files`}
            data={rows.map((r) => ({ ...r, id: r.workflowFile }))}
            columns={columns}
            dataGridProps={{
              getRowId: (r: any) => r.workflowFile,
              initialState: {
                sorting: {
                  sortModel: [{ field: "legacyJobs", sort: "desc" }],
                },
              },
            }}
            showFooter={true}
            disableAutoPageSize={true}
            pageSize={25}
          />
        </Box>
      </Paper>

      {treeUnavailable && (
        <Typography
          variant="caption"
          sx={{ display: "block", mb: 1, color: "#c77700", fontWeight: 600 }}
        >
          Could not read this repo&apos;s workflow file list from GitHub, so
          only files that ran CI in the window are shown — files with no recent
          CI are missing from the table.
        </Typography>
      )}
      {REFERENCE_REPOS.includes(repo) && (
        <Typography variant="caption" sx={{ display: "block", mb: 1 }}>
          <b>Reference repo.</b> pytorch/pytorch has already completed this
          migration, so it shows what &ldquo;done&rdquo; looks like. It is not
          directly comparable to the repos above: it reaches OSDC via runtime
          label translation (<code>.github/arc.yaml</code> +{" "}
          <code>map_ec2_to_arc.py</code>), so its workflow YAML still reads as
          EC2 even where the jobs run on ARC.
        </Typography>
      )}
      <Typography variant="caption" sx={{ opacity: 0.7 }}>
        Each file is judged by the fleet its Linux jobs actually ran on:{" "}
        <b>Migrated</b> = only OSDC, <b>Unmigrated</b> = only legacy EC2,{" "}
        <b>Partial</b> = both (see % legacy). A file whose jobs all ran
        somewhere OSDC does not replace — GitHub-hosted runners, partner
        hardware (ROCm / XPU / TPU), or Windows and macOS, which have no ARC
        equivalent yet — is excluded from the percentage as{" "}
        <b>Nothing to migrate</b>. Files with no CI activity in the window are
        listed as <b>Not run in window</b> and are also excluded — they are
        unknown, not migrated. The file percentage counts a Partial file as not
        yet migrated; the job percentage does not, which is why the two diverge
        as a repo nears the end.
      </Typography>
    </div>
  );
}
