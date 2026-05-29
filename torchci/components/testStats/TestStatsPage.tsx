import {
  Box,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  useTheme,
} from "@mui/material";
import { ensureUtc } from "components/autorevert/types";
import LoadingPage from "components/common/LoadingPage";
import { LocalTimeHuman } from "components/common/TimeUtils";
import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import { useRouter } from "next/router";

const REPO = "pytorch/pytorch";
const REF = "refs/heads/main";
const WORKFLOW = "trunk";
const DEFAULT_COUNT = 30;
const MAX_COUNT = 200;

type Row = {
  sha: string;
  message: string;
  author: string;
  time: string;
  workflow_id: number | null;
  success: number;
  skipped: number;
  flaky: number;
  failure: number;
  pending_jobs: number;
};

const COUNT_KEYS = ["success", "skipped", "flaky", "failure"] as const;
type CountKey = typeof COUNT_KEYS[number];

function formatDelta(d: number | undefined): string {
  if (d === undefined) return "";
  if (d === 0) return "0";
  return d > 0 ? `+${d}` : `${d}`;
}

function deltaColor(
  key: CountKey,
  delta: number,
  mode: "light" | "dark"
): string | undefined {
  if (delta === 0) return undefined;
  // For success: more is better. For skipped/flaky/failure: more is worse.
  const isImprovement = key === "success" ? delta > 0 : delta < 0;
  if (mode === "dark") {
    return isImprovement ? "#4caf50" : "#ef5350";
  }
  return isImprovement ? "#1b5e20" : "#b71c1c";
}

export function TestStatsPage({
  title,
  jobFilter,
}: {
  title: string;
  jobFilter: string;
}) {
  const router = useRouter();
  const theme = useTheme();
  const mode = theme.palette.mode;

  const parsed = parseInt((router.query.count as string) ?? "");
  const count = Number.isFinite(parsed)
    ? Math.max(1, Math.min(MAX_COUNT, parsed))
    : DEFAULT_COUNT;
  const shaParam = ((router.query.sha as string) ?? "").trim();
  // Only forward full 40-char or short (>=7) hex shas; anything else is ignored
  // and the query falls back to "most recent".
  const sha = /^[0-9a-f]{7,40}$/i.test(shaParam) ? shaParam : "";

  const { data, error, isLoading } = useClickHouseAPIImmutable<Row>(
    "test_stats_per_commit",
    {
      repo: REPO,
      ref: REF,
      workflow: WORKFLOW,
      jobFilter,
      count,
      sha,
    }
  );

  if (error) {
    return (
      <Stack spacing={2} sx={{ p: 2 }}>
        <Typography variant="h4">{title}</Typography>
        <Typography color="error">Error loading data: {`${error}`}</Typography>
      </Stack>
    );
  }
  if (isLoading || !data) {
    return <LoadingPage />;
  }

  // Iterate oldest -> newest so deltas reference the prior commit, then flip
  // back to newest-first for display.
  const oldestFirst = [...data].reverse();
  const deltas: Record<string, Partial<Record<CountKey, number>>> = {};
  let prevCounts: Record<CountKey, number> | null = null;
  for (const row of oldestFirst) {
    if (row.workflow_id == null) {
      deltas[row.sha] = {};
      prevCounts = null;
      continue;
    }
    const curr: Record<CountKey, number> = {
      success: row.success,
      skipped: row.skipped,
      flaky: row.flaky,
      failure: row.failure,
    };
    deltas[row.sha] = {};
    if (prevCounts) {
      for (const k of COUNT_KEYS) {
        deltas[row.sha][k] = curr[k] - prevCounts[k];
      }
    }
    prevCounts = curr;
  }

  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Typography variant="h4">{title}</Typography>
      <Typography>
        Per-commit pass/skip/flaky/fail counts for the last {count} commits on{" "}
        <code>
          {REPO}@{REF.replace("refs/heads/", "")}
        </code>
        {sha ? (
          <>
            {" "}
            ending at <code>{sha}</code>
          </>
        ) : null}
        , restricted to the <code>{WORKFLOW}</code> workflow and jobs matching{" "}
        <code>{jobFilter}</code>. Δ is relative to the previous commit shown.
        Rows tinted amber (⏳) still have running jobs &mdash; counts may rise.
        URL params: <code>?count=N</code> (max {MAX_COUNT}),{" "}
        <code>?sha=&lt;hex&gt;</code> to end the window at a specific commit.
      </Typography>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Commit</TableCell>
              <TableCell>Time</TableCell>
              <TableCell align="right">Pass</TableCell>
              <TableCell align="right">Δ</TableCell>
              <TableCell align="right">Skip</TableCell>
              <TableCell align="right">Δ</TableCell>
              <TableCell align="right">Flaky</TableCell>
              <TableCell align="right">Δ</TableCell>
              <TableCell align="right">Fail</TableCell>
              <TableCell align="right">Δ</TableCell>
              <TableCell>Title</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data.map((row) => {
              const hasRun = row.workflow_id != null;
              const rowDeltas = deltas[row.sha] ?? {};
              const title = (row.message ?? "").split("\n")[0].slice(0, 80);
              const pending = row.pending_jobs > 0;
              // Subtle amber tint so the row stands out without clashing with
              // the red/green delta colors. Lower alpha on dark mode.
              const pendingBg = pending
                ? mode === "dark"
                  ? "rgba(255, 193, 7, 0.12)"
                  : "rgba(255, 193, 7, 0.18)"
                : undefined;
              return (
                <TableRow
                  key={row.sha}
                  hover
                  sx={{ backgroundColor: pendingBg }}
                  title={
                    pending
                      ? `${row.pending_jobs} job(s) still running`
                      : undefined
                  }
                >
                  <TableCell>
                    <Link
                      href={`/${REPO}/commit/${row.sha}`}
                      sx={{ fontFamily: "monospace" }}
                    >
                      {row.sha.slice(0, 9)}
                    </Link>
                    {pending ? (
                      <Box
                        component="span"
                        sx={{ ml: 1, fontSize: "0.85em" }}
                        aria-label={`${row.pending_jobs} jobs still running`}
                      >
                        ⏳
                      </Box>
                    ) : null}
                  </TableCell>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>
                    <LocalTimeHuman timestamp={ensureUtc(row.time)} />
                  </TableCell>
                  {hasRun ? (
                    COUNT_KEYS.flatMap((k) => {
                      const delta = rowDeltas[k];
                      const color =
                        delta !== undefined
                          ? deltaColor(k, delta, mode)
                          : undefined;
                      return [
                        <TableCell key={`${k}-v`} align="right">
                          {row[k]}
                        </TableCell>,
                        <TableCell
                          key={`${k}-d`}
                          align="right"
                          sx={{ color, fontVariantNumeric: "tabular-nums" }}
                        >
                          {formatDelta(delta)}
                        </TableCell>,
                      ];
                    })
                  ) : (
                    <TableCell
                      colSpan={8}
                      align="center"
                      sx={{ color: theme.palette.text.secondary }}
                    >
                      (no {WORKFLOW} run)
                    </TableCell>
                  )}
                  <TableCell sx={{ maxWidth: 500 }}>
                    <Box
                      sx={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={row.message}
                    >
                      {title}
                    </Box>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}
