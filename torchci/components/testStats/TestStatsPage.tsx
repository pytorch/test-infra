import {
  Box,
  Button,
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
  run_status: string | null;
};

const COUNT_KEYS = ["total", "skipped", "flaky", "failure"] as const;
type CountKey = typeof COUNT_KEYS[number];

const COUNT_LABELS: Record<CountKey, string> = {
  total: "Total",
  skipped: "Skip",
  flaky: "Flaky",
  failure: "Fail",
};

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
  // For total: more tests is "more coverage" → green. For skipped/flaky/failure:
  // more is worse → red.
  const isImprovement = key === "total" ? delta > 0 : delta < 0;
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
  // and the query falls back to "most recent". Lowercased so a SHA pasted from
  // GitHub's URL still matches the case-sensitive startsWith() in the query.
  const sha = /^[0-9a-f]{7,40}$/i.test(shaParam) ? shaParam.toLowerCase() : "";

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

  // Pre-compute the "total" column (sum of every category, not just success).
  const counts: Record<string, Record<CountKey, number>> = {};
  for (const row of data) {
    counts[row.sha] = {
      total: row.success + row.skipped + row.flaky + row.failure,
      skipped: row.skipped,
      flaky: row.flaky,
      failure: row.failure,
    };
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
    const curr = counts[row.sha];
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
        Per-commit total/skip/flaky/fail counts for the last {count} commits on{" "}
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
      <Stack direction="row" spacing={1}>
        <Button
          variant="outlined"
          size="small"
          disabled={!sha}
          onClick={() => {
            // Drop ?sha so we go back to the HEAD window. Works for both the
            // "navigated via Next" case and the "landed on a sha-anchored URL
            // directly" case (where router.back() would leave the page).
            const { sha: _drop, ...rest } = router.query;
            router.push({ pathname: router.pathname, query: rest });
          }}
        >
          ← Prev
        </Button>
        <Button
          variant="outlined"
          size="small"
          disabled={data.length === 0}
          onClick={() =>
            router.push({
              pathname: router.pathname,
              query: { ...router.query, sha: data[data.length - 1].sha, count },
            })
          }
        >
          Next →
        </Button>
      </Stack>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Commit</TableCell>
              <TableCell>Time</TableCell>
              {COUNT_KEYS.flatMap((k) => [
                <TableCell key={`${k}-h`} align="right">
                  {COUNT_LABELS[k]}
                </TableCell>,
                <TableCell key={`${k}-dh`} align="right">
                  Δ
                </TableCell>,
              ])}
              <TableCell>Title</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data.map((row) => {
              const hasRun = row.workflow_id != null;
              const rowDeltas = deltas[row.sha] ?? {};
              const commitTitle = (row.message ?? "")
                .split("\n")[0]
                .slice(0, 80);
              // Pending if any matched job is still running, OR if the run
              // itself is queued/in_progress (in which case workflow_job rows
              // for the matched jobs may not exist yet, so pending_jobs is 0).
              const runPending =
                hasRun &&
                row.run_status !== null &&
                row.run_status !== "completed";
              const pending = row.pending_jobs > 0 || runPending;
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
                      ? runPending && row.pending_jobs === 0
                        ? `workflow run is ${row.run_status}`
                        : `${row.pending_jobs} job(s) still running`
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
                          {counts[row.sha][k]}
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
                      {commitTitle}
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
