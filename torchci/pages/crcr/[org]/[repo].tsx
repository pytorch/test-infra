import {
  Box,
  Chip,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Paper,
  Select,
  SelectChangeEvent,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import { durationDisplay } from "components/common/TimeUtils";
import { fetcher } from "lib/GeneralUtils";
import { conclusionColor, conclusionLabel } from "lib/crcr/crcrUtils";
import Head from "next/head";
import NextLink from "next/link";
import { useRouter } from "next/router";
import { useMemo } from "react";
import useSWR from "swr";

interface CrcrJobRow {
  upstream_repo: string;
  pr_number: number;
  pytorch_head_sha: string;
  workflow_name: string;
  job_name: string;
  check_run_id: string;
  run_id: string;
  run_attempt: number;
  status: string;
  conclusion: string;
  started_at: string;
  completed_at: string;
  duration_seconds: number;
  total_tests: number;
  passed_tests: number;
  failed_tests: number;
  skipped_tests: number;
  workflow_run_url: string;
  artifact_url: string;
  queue_time: number | null;
  execution_time: number | null;
}

function JobChip({ job }: { job: CrcrJobRow }) {
  const color = conclusionColor(job.status, job.conclusion);
  const label = conclusionLabel(job.status, job.conclusion);
  const tooltipContent = [
    `Job: ${job.job_name}`,
    job.run_attempt > 1 ? `Attempt: ${job.run_attempt}` : null,
    `Duration: ${
      job.duration_seconds
        ? durationDisplay(Math.round(job.duration_seconds))
        : "–"
    }`,
    job.total_tests
      ? `Tests: ${job.passed_tests}/${job.total_tests} passed`
      : null,
    job.queue_time != null ? `Queue: ${job.queue_time.toFixed(1)}s` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <Tooltip
      title={<span style={{ whiteSpace: "pre-line" }}>{tooltipContent}</span>}
    >
      <Chip
        label={label}
        color={color}
        size="small"
        component="a"
        href={job.workflow_run_url}
        target="_blank"
        rel="noopener"
        clickable
        sx={{ mx: 0.25 }}
      />
    </Tooltip>
  );
}

interface MatrixRow {
  prNumber: number;
  sha: string;
  upstreamRepo: string;
  jobs: Map<string, CrcrJobRow>;
}

function buildMatrix(data: CrcrJobRow[]): {
  jobNames: string[];
  rows: MatrixRow[];
} {
  const jobNamesSet = new Set<string>();
  const prMap = new Map<number, MatrixRow>();

  for (const job of data) {
    jobNamesSet.add(job.job_name);
    let row = prMap.get(job.pr_number);
    if (!row) {
      row = {
        prNumber: job.pr_number,
        sha: job.pytorch_head_sha,
        upstreamRepo: job.upstream_repo ?? "pytorch/pytorch",
        jobs: new Map(),
      };
      prMap.set(job.pr_number, row);
    }
    // Keep the latest attempt per job_name (highest run_attempt wins)
    const existing = row.jobs.get(job.job_name);
    if (!existing || job.run_attempt > existing.run_attempt) {
      row.jobs.set(job.job_name, job);
    }
  }

  const jobNames = Array.from(jobNamesSet).sort();
  const rows = Array.from(prMap.values()).sort(
    (a, b) => b.prNumber - a.prNumber
  );
  return { jobNames, rows };
}

function HealthSummary({ data }: { data: CrcrJobRow[] }) {
  const completed = data.filter((j) => j.status === "completed");
  const total = completed.length;
  const success = completed.filter((j) => j.conclusion === "success").length;
  const rate = total > 0 ? success / total : 0;

  return (
    <Stack direction="row" spacing={2} alignItems="center">
      <Chip
        label={`Pass rate: ${(rate * 100).toFixed(1)}%`}
        color={rate >= 0.95 ? "success" : rate >= 0.8 ? "warning" : "error"}
      />
      <Typography variant="body2" color="text.secondary">
        {success}/{total} jobs passed (this page)
      </Typography>
    </Stack>
  );
}

const PER_PAGE = 50;

function CrcrPagination({
  page,
  hasNextPage,
  onPageChange,
}: {
  page: number;
  hasNextPage: boolean;
  onPageChange: (page: number) => void;
}) {
  return (
    <div>
      Page {page}:{" "}
      {page > 1 ? (
        <Link
          component="button"
          underline="hover"
          onClick={() => onPageChange(page - 1)}
        >
          Prev
        </Link>
      ) : (
        <span>Prev</span>
      )}{" "}
      |{" "}
      {hasNextPage ? (
        <Link
          component="button"
          underline="hover"
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Link>
      ) : (
        <span>Next</span>
      )}
    </div>
  );
}

function CrcrMatrix({
  repoFullName,
  days,
  page,
  onPageChange,
}: {
  repoFullName: string;
  days: number;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const offset = (page - 1) * PER_PAGE;
  const url = `/api/clickhouse/crcr_backend_dashboard?parameters=${encodeURIComponent(
    JSON.stringify({
      repo: repoFullName,
      days: String(days),
      per_page: String(PER_PAGE + 1),
      offset: String(offset),
    })
  )}`;
  const { data, error } = useSWR<CrcrJobRow[]>(url, fetcher, {
    refreshInterval: 60_000,
  });

  const { matrix, hasNextPage } = useMemo(() => {
    if (!data) return { matrix: null, hasNextPage: false };
    const full = buildMatrix(data);
    const hasMore = full.rows.length > PER_PAGE;
    return {
      matrix: {
        jobNames: full.jobNames,
        rows: full.rows.slice(0, PER_PAGE),
      },
      hasNextPage: hasMore,
    };
  }, [data]);

  if (error) {
    return (
      <Typography color="error">
        Failed to load dashboard: {error.message}
      </Typography>
    );
  }
  if (!data || !matrix) {
    return <Skeleton variant="rectangular" height={400} />;
  }
  if (data.length === 0) {
    return (
      <>
        <Typography color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
          No results for {repoFullName} in the last {days} days.
        </Typography>
        {page > 1 && (
          <CrcrPagination
            page={page}
            hasNextPage={false}
            onPageChange={onPageChange}
          />
        )}
      </>
    );
  }

  return (
    <>
      <HealthSummary data={data} />
      <TableContainer component={Paper} elevation={2} sx={{ mt: 2 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>
                <strong>PR</strong>
              </TableCell>
              <TableCell>
                <strong>SHA</strong>
              </TableCell>
              {matrix.jobNames.map((name) => (
                <TableCell key={name} align="center">
                  <strong>{name}</strong>
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {matrix.rows.map((row) => (
              <TableRow key={row.prNumber} hover>
                <TableCell>
                  <NextLink
                    href={`https://github.com/${
                      row.upstreamRepo ?? "pytorch/pytorch"
                    }/pull/${row.prNumber}`}
                    passHref
                    legacyBehavior
                  >
                    <Link target="_blank" rel="noopener" underline="hover">
                      #{row.prNumber}
                    </Link>
                  </NextLink>
                </TableCell>
                <TableCell>
                  <Typography variant="body2" fontFamily="monospace">
                    {row.sha.slice(0, 7)}
                  </Typography>
                </TableCell>
                {matrix.jobNames.map((name) => {
                  const job = row.jobs.get(name);
                  return (
                    <TableCell key={name} align="center">
                      {job ? <JobChip job={job} /> : "–"}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Box sx={{ mt: 2 }}>
        <CrcrPagination
          page={page}
          hasNextPage={hasNextPage}
          onPageChange={onPageChange}
        />
      </Box>
    </>
  );
}

export default function CrcrBackendPage() {
  const router = useRouter();
  const { org, repo } = router.query;

  const page = parseInt(router.query.page as string) || 1;
  const days = parseInt(router.query.days as string) || 7;

  if (!org || !repo) return null;

  const repoFullName = `${org}/${repo}`;

  function updateQuery(updates: Record<string, string | number>) {
    router.push(
      { pathname: router.pathname, query: { ...router.query, ...updates } },
      undefined,
      { shallow: true }
    );
  }

  return (
    <>
      <Head>
        <title>{repoFullName} — CRCR CI | PyTorch HUD</title>
      </Head>
      <Stack spacing={3} sx={{ p: 3, maxWidth: 1600, mx: "auto" }}>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Stack spacing={0.5}>
            <Typography variant="h4">{repoFullName}</Typography>
            <NextLink href="/crcr" passHref legacyBehavior>
              <Link variant="body2" underline="hover">
                ← Back to CRCR Summary
              </Link>
            </NextLink>
          </Stack>
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel>Time Range</InputLabel>
            <Select
              value={days}
              label="Time Range"
              onChange={(e: SelectChangeEvent<number>) =>
                updateQuery({ days: Number(e.target.value), page: 1 })
              }
            >
              <MenuItem value={1}>Last 24h</MenuItem>
              <MenuItem value={7}>Last 7 days</MenuItem>
              <MenuItem value={30}>Last 30 days</MenuItem>
            </Select>
          </FormControl>
        </Box>

        <Typography variant="body2" color="text.secondary">
          Rows = PyTorch PRs (50 per page), columns = downstream CI jobs. Click
          a chip to open the workflow run.
        </Typography>

        <CrcrMatrix
          repoFullName={repoFullName}
          days={days}
          page={page}
          onPageChange={(p) => updateQuery({ page: p })}
        />
      </Stack>
    </>
  );
}
