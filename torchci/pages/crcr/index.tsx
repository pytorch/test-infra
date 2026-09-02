import {
  Box,
  Chip,
  Divider,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Paper,
  Select,
  SelectChangeEvent,
  Skeleton,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  Typography,
} from "@mui/material";
import { durationDisplay } from "components/common/TimeUtils";
import { fetcherHandleError } from "lib/GeneralUtils";
import Head from "next/head";
import NextLink from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";

import type { AllowlistEntry, AllowlistResponse } from "../api/crcr/allowlist";

interface CiMetricsRow {
  repo: string;
  downstream_repo_level: string;
  successes: number;
  failures: number;
  timed_out: number;
  total: number;
  pass_rate: number;
  avg_duration_s: number;
  last_run: string;
}

interface NightlyMetricsRow {
  repo: string;
  downstream_repo_level: string;
  successes: number;
  failures: number;
  timed_out: number;
  total: number;
  pass_rate: number;
  avg_duration_s: number;
  last_run: string;
  latest_sha: string;
}

interface HealthPrRow {
  pr_number: number;
  last_run: string;
  successes: number;
  total: number;
  pass_rate: number;
}

type EventTab = "pr" | "nightly";

type Level = "L1" | "L2" | "L3" | "L4";

const LEVEL_META: Record<
  Level,
  { label: string; description: string; color: string }
> = {
  L4: {
    label: "L4 Backends (merge-gating)",
    description:
      "Blocking check run on every PR; reserved for critical accelerators.",
    color: "#7b1fa2",
  },
  L3: {
    label: "L3 Backends (check runs on PR)",
    description:
      "Non-blocking check run on PRs when ciflow/crcr/<name> label is applied.",
    color: "#ed6c02",
  },
  L2: {
    label: "L2 Backends (callback-only)",
    description: "CI results displayed on the HUD page, but not on PRs.",
    color: "#0288d1",
  },
  L1: {
    label: "L1 Integrations (webhook-only)",
    description:
      "Repos receive webhook notifications on new commits. No CI results reported back.",
    color: "#9e9e9e",
  },
};

const LEVELS_ORDERED: Level[] = ["L4", "L3", "L2", "L1"];
const CRCR_HEALTH_REPO = "pytorch/crcr-test";

function PassRateChip({ rate }: { rate: number }) {
  const pct = (rate * 100).toFixed(1) + "%";
  if (rate >= 0.95) return <Chip label={pct} color="success" size="small" />;
  if (rate >= 0.8) return <Chip label={pct} color="warning" size="small" />;
  return <Chip label={pct} color="error" size="small" />;
}

function LevelChip({ level }: { level: Level }) {
  const meta = LEVEL_META[level];
  return (
    <Chip
      label={level}
      size="small"
      variant="outlined"
      sx={{ borderColor: meta.color, color: meta.color }}
    />
  );
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function CiHealthTable({
  level,
  repos,
  metricsMap,
}: {
  level: Level;
  repos: AllowlistEntry[];
  metricsMap: Map<string, CiMetricsRow>;
}) {
  return (
    <TableContainer component={Paper} elevation={1}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: 28 }} />
            <TableCell>
              <strong>Backend Repository</strong>
            </TableCell>
            <TableCell align="center">
              <strong>Level</strong>
            </TableCell>
            <TableCell align="right">
              <strong>Pass Rate</strong>
            </TableCell>
            <TableCell align="right">
              <strong>Success</strong>
            </TableCell>
            <TableCell align="right">
              <strong>Failures</strong>
            </TableCell>
            <TableCell align="right">
              <strong>Total</strong>
            </TableCell>
            <TableCell align="right">
              <strong>Avg Duration</strong>
            </TableCell>
            <TableCell align="right">
              <strong>Last Run</strong>
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {repos.map((entry) => {
            const metrics = metricsMap.get(entry.repo);
            const parts = entry.repo.split("/");
            if (parts.length !== 2) return null;
            const [org, repo] = parts;
            const hasData = !!metrics;
            return (
              <TableRow
                key={entry.repo}
                hover
                sx={{ cursor: hasData ? "pointer" : "default" }}
              >
                <TableCell align="center">
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      bgcolor: hasData ? "success.main" : "grey.400",
                      display: "inline-block",
                    }}
                    title={hasData ? "Active" : "No data"}
                  />
                </TableCell>
                <TableCell>
                  {hasData ? (
                    <NextLink
                      href={`/crcr/${org}/${repo}`}
                      passHref
                      legacyBehavior
                    >
                      <Link underline="hover">{entry.repo}</Link>
                    </NextLink>
                  ) : (
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      component="span"
                    >
                      {entry.repo}
                    </Typography>
                  )}
                </TableCell>
                <TableCell align="center">
                  <LevelChip level={level} />
                </TableCell>
                <TableCell align="right">
                  {metrics ? (
                    <PassRateChip rate={metrics.pass_rate} />
                  ) : (
                    <Typography variant="body2" color="text.disabled">
                      –
                    </Typography>
                  )}
                </TableCell>
                <TableCell align="right">{metrics?.successes ?? "–"}</TableCell>
                <TableCell align="right">
                  {metrics ? (
                    <Typography
                      variant="body2"
                      component="span"
                      sx={{
                        color:
                          metrics.failures > 0 ? "error.main" : "text.primary",
                        fontWeight: metrics.failures > 0 ? 500 : 400,
                      }}
                    >
                      {metrics.failures}
                    </Typography>
                  ) : (
                    "–"
                  )}
                </TableCell>
                <TableCell align="right">{metrics?.total ?? "–"}</TableCell>
                <TableCell align="right">
                  {metrics
                    ? durationDisplay(Math.round(metrics.avg_duration_s))
                    : "–"}
                </TableCell>
                <TableCell align="right">
                  {metrics ? (
                    <Typography variant="body2" color="text.secondary">
                      {timeAgo(metrics.last_run)}
                    </Typography>
                  ) : (
                    "–"
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function L1Section({ repos }: { repos: AllowlistEntry[] }) {
  if (repos.length === 0) return null;
  return (
    <Paper elevation={1} sx={{ p: 2 }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {LEVEL_META.L1.description}
      </Typography>
      <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
        {repos.map((entry) => (
          <Link
            key={entry.repo}
            href={`https://github.com/${entry.repo}`}
            target="_blank"
            rel="noopener"
            underline="hover"
            sx={{
              fontSize: "0.85rem",
              display: "inline-flex",
              alignItems: "center",
              gap: 0.5,
            }}
          >
            <LevelChip level="L1" />
            {entry.repo}
          </Link>
        ))}
      </Box>
    </Paper>
  );
}

function NightlyTable({
  nightlyData,
  days,
}: {
  nightlyData: NightlyMetricsRow[];
  days: number;
}) {
  return (
    <TableContainer component={Paper} elevation={1}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: 28 }} />
            <TableCell>
              <strong>Repository</strong>
            </TableCell>
            <TableCell align="center">
              <strong>Level</strong>
            </TableCell>
            <TableCell align="center">
              <strong>Pass Rate</strong>
            </TableCell>
            <TableCell align="right">
              <strong>Success</strong>
            </TableCell>
            <TableCell align="right">
              <strong>Failures</strong>
            </TableCell>
            <TableCell align="right">
              <strong>Total</strong>
            </TableCell>
            <TableCell align="right">
              <strong>SHA</strong>
            </TableCell>
            <TableCell align="right">
              <strong>Last Run</strong>
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {nightlyData.map((row) => {
            const parts = row.repo.split("/");
            if (parts.length !== 2) return null;
            const [org, repo] = parts;
            const level = (row.downstream_repo_level || "L2") as Level;
            return (
              <TableRow key={row.repo} hover>
                <TableCell align="center">
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      bgcolor:
                        row.pass_rate >= 0.95
                          ? "success.main"
                          : row.pass_rate >= 0.8
                          ? "warning.main"
                          : "error.main",
                      display: "inline-block",
                    }}
                  />
                </TableCell>
                <TableCell>
                  <NextLink
                    href={`/crcr/${org}/${repo}?event=nightly&days=${days}`}
                    passHref
                    legacyBehavior
                  >
                    <Link underline="hover">{row.repo}</Link>
                  </NextLink>
                </TableCell>
                <TableCell align="center">
                  <LevelChip level={level} />
                </TableCell>
                <TableCell align="center">
                  <PassRateChip rate={row.pass_rate} />
                </TableCell>
                <TableCell align="right">{row.successes}</TableCell>
                <TableCell align="right">
                  <Typography
                    variant="body2"
                    component="span"
                    sx={{
                      color: row.failures > 0 ? "error.main" : "text.primary",
                      fontWeight: row.failures > 0 ? 500 : 400,
                    }}
                  >
                    {row.failures}
                  </Typography>
                </TableCell>
                <TableCell align="right">{row.total}</TableCell>
                <TableCell align="right">
                  {row.latest_sha ? (
                    <Link
                      href={`https://github.com/pytorch/pytorch/commit/${row.latest_sha}`}
                      target="_blank"
                      rel="noopener"
                      sx={{ fontFamily: "monospace", fontSize: "0.8rem" }}
                    >
                      {row.latest_sha.slice(0, 7)}
                    </Link>
                  ) : (
                    "–"
                  )}
                </TableCell>
                <TableCell align="right">
                  <Typography variant="body2" color="text.secondary">
                    {timeAgo(row.last_run)}
                  </Typography>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <Paper
      elevation={1}
      sx={{ p: 2, minWidth: 160, flex: 1, textAlign: "center" }}
    >
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h5" sx={{ fontWeight: 600 }}>
        {value}
      </Typography>
      {sub && (
        <Typography variant="caption" color="text.secondary">
          {sub}
        </Typography>
      )}
    </Paper>
  );
}

function CrcrTestHealthCard({
  healthPrs,
}: {
  healthPrs: HealthPrRow[] | undefined;
}) {
  if (!healthPrs || healthPrs.length === 0) return null;
  const allPassed = healthPrs.every((pr) => pr.pass_rate >= 1.0);
  const passedCount = healthPrs.filter((pr) => pr.pass_rate >= 1.0).length;
  const borderColor = allPassed ? "#2e7d32" : "#ed6c02";
  const label = allPassed ? "Healthy" : "Degraded";
  return (
    <NextLink href="/crcr/pytorch/crcr-test" passHref legacyBehavior>
      <Paper
        component="a"
        elevation={2}
        sx={{
          p: 2,
          flex: 1,
          minWidth: 160,
          textAlign: "center",
          borderLeft: `4px solid ${borderColor}`,
          textDecoration: "none",
          color: "inherit",
          cursor: "pointer",
          "&:hover": { bgcolor: "action.hover" },
        }}
      >
        <Typography variant="caption" color="text.secondary">
          CRCR Relay Health
        </Typography>
        <Typography variant="h5" sx={{ fontWeight: 600, color: borderColor }}>
          {label}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {passedCount}/{healthPrs.length} recent PRs passed · pytorch/crcr-test
        </Typography>
      </Paper>
    </NextLink>
  );
}

interface NightlyJobRow {
  pytorch_head_sha: string;
  job_name: string;
  status: string;
  conclusion: string;
  started_at: string;
}

const NIGHTLY_HEALTH_COUNT = 5;

function isExpectedNightlyOutcome(job: NightlyJobRow): boolean {
  const name = job.job_name ?? "";
  return (
    (name.includes("xfail") && job.conclusion === "failure") ||
    (name.includes("xcancel") && job.conclusion === "cancelled") ||
    (name.includes("xtimeout") && job.conclusion === "timed_out")
  );
}

function isNightlyJobPassing(job: NightlyJobRow): boolean {
  if (job.status !== "completed") return false;
  return job.conclusion === "success" || isExpectedNightlyOutcome(job);
}

function CrcrNightlyHealthCard({
  nightlyJobs,
}: {
  nightlyJobs: NightlyJobRow[] | undefined;
}) {
  if (!nightlyJobs || nightlyJobs.length === 0) {
    const staleColor = "#9e9e9e";
    return (
      <NextLink
        href="/crcr/pytorch/crcr-test?event=nightly"
        passHref
        legacyBehavior
      >
        <Paper
          component="a"
          elevation={2}
          sx={{
            p: 2,
            flex: 1,
            minWidth: 160,
            textAlign: "center",
            borderLeft: `4px solid ${staleColor}`,
            textDecoration: "none",
            color: "inherit",
            cursor: "pointer",
            "&:hover": { bgcolor: "action.hover" },
          }}
        >
          <Typography variant="caption" color="text.secondary">
            CRCR Relay Health - Nightly
          </Typography>
          <Typography variant="h5" sx={{ fontWeight: 600, color: staleColor }}>
            No Data
          </Typography>
          <Typography variant="caption" color="text.secondary">
            no nightly results in last 14 days
          </Typography>
        </Paper>
      </NextLink>
    );
  }

  const shaMap = new Map<string, NightlyJobRow[]>();
  for (const job of nightlyJobs) {
    if (!job.pytorch_head_sha) continue;
    const jobs = shaMap.get(job.pytorch_head_sha) ?? [];
    jobs.push(job);
    shaMap.set(job.pytorch_head_sha, jobs);
  }

  const shasByTime = Array.from(shaMap.entries())
    .map(([sha, jobs]) => ({
      sha,
      jobs,
      latestTime: Math.max(
        ...jobs.map((j) => new Date(j.started_at).getTime())
      ),
    }))
    .sort((a, b) => b.latestTime - a.latestTime)
    .slice(0, NIGHTLY_HEALTH_COUNT);

  if (shasByTime.length === 0) {
    const staleColor = "#9e9e9e";
    return (
      <NextLink
        href="/crcr/pytorch/crcr-test?event=nightly"
        passHref
        legacyBehavior
      >
        <Paper
          component="a"
          elevation={2}
          sx={{
            p: 2,
            flex: 1,
            minWidth: 160,
            textAlign: "center",
            borderLeft: `4px solid ${staleColor}`,
            textDecoration: "none",
            color: "inherit",
            cursor: "pointer",
            "&:hover": { bgcolor: "action.hover" },
          }}
        >
          <Typography variant="caption" color="text.secondary">
            CRCR Relay Health - Nightly
          </Typography>
          <Typography variant="h5" sx={{ fontWeight: 600, color: staleColor }}>
            No Data
          </Typography>
          <Typography variant="caption" color="text.secondary">
            no nightly results in last 14 days
          </Typography>
        </Paper>
      </NextLink>
    );
  }

  const allPassed = shasByTime.every((entry) =>
    entry.jobs.every(isNightlyJobPassing)
  );
  const passedCount = shasByTime.filter((entry) =>
    entry.jobs.every(isNightlyJobPassing)
  ).length;
  const borderColor = allPassed ? "#2e7d32" : "#ed6c02";
  const label = allPassed ? "Healthy" : "Degraded";

  return (
    <NextLink
      href="/crcr/pytorch/crcr-test?event=nightly"
      passHref
      legacyBehavior
    >
      <Paper
        component="a"
        elevation={2}
        sx={{
          p: 2,
          flex: 1,
          minWidth: 160,
          textAlign: "center",
          borderLeft: `4px solid ${borderColor}`,
          textDecoration: "none",
          color: "inherit",
          cursor: "pointer",
          "&:hover": { bgcolor: "action.hover" },
        }}
      >
        <Typography variant="caption" color="text.secondary">
          CRCR Relay Health - Nightly
        </Typography>
        <Typography variant="h5" sx={{ fontWeight: 600, color: borderColor }}>
          {label}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {passedCount}/{shasByTime.length} recent nightlies passed
        </Typography>
      </Paper>
    </NextLink>
  );
}

export default function CrcrSummaryPage() {
  const [days, setDays] = useState(7);
  const [activeTab, setActiveTab] = useState<EventTab>("pr");

  const ciUrl = `/api/clickhouse/crcr_summary?parameters=${encodeURIComponent(
    JSON.stringify({ days: String(days) })
  )}`;
  const { data: ciData, error: ciError } = useSWR<CiMetricsRow[]>(
    ciUrl,
    fetcherHandleError,
    { refreshInterval: 60_000 }
  );
  const { data: allowlist, error: alError } = useSWR<AllowlistResponse>(
    "/api/crcr/allowlist",
    fetcherHandleError,
    { refreshInterval: 5 * 60_000 }
  );

  const nightlyUrl =
    `/api/clickhouse/crcr_nightly_summary?parameters=` +
    encodeURIComponent(JSON.stringify({ days: String(days) }));
  const { data: nightlyData, error: nightlyError } = useSWR<
    NightlyMetricsRow[]
  >(nightlyUrl, fetcherHandleError, { refreshInterval: 60_000 });

  const healthUrl =
    `/api/clickhouse/crcr_health_last_prs?parameters=` +
    encodeURIComponent(JSON.stringify({ count: "5" }));
  const { data: healthPrs, error: healthError } = useSWR<HealthPrRow[]>(
    healthUrl,
    fetcherHandleError,
    { refreshInterval: 60_000 }
  );

  const nightlyHealthUrl =
    `/api/clickhouse/crcr_nightly_dashboard?parameters=` +
    encodeURIComponent(
      JSON.stringify({ repo: "pytorch/crcr-test", days: "14" })
    );
  const { data: nightlyHealthJobs, error: nightlyHealthError } = useSWR<
    NightlyJobRow[]
  >(nightlyHealthUrl, fetcherHandleError, {
    refreshInterval: 60_000,
  });

  const visibleNightlyData = useMemo(
    () => nightlyData?.filter((r) => r.repo !== CRCR_HEALTH_REPO) ?? [],
    [nightlyData],
  );
  const nightlyRepoCount = visibleNightlyData.length;

  const metricsMap = useMemo(() => {
    const map = new Map<string, CiMetricsRow>();
    if (!ciData) return map;
    for (const row of ciData) {
      map.set(row.repo, row);
    }
    return map;
  }, [ciData]);

  // Merge: for L2-L4, combine allowlist repos with any ClickHouse-only repos
  // (repos that report data but aren't yet in the allowlist)
  const reposByLevel = useMemo(() => {
    const result: Record<Level, AllowlistEntry[]> = {
      L1: [],
      L2: [],
      L3: [],
      L4: [],
    };
    if (!allowlist) return result;

    const seen = new Set<string>();
    for (const level of LEVELS_ORDERED) {
      for (const entry of allowlist[level]) {
        if (entry.repo === CRCR_HEALTH_REPO) continue;
        result[level].push(entry);
        seen.add(entry.repo);
      }
    }

    // Add ClickHouse-only repos (not in allowlist) under their reported level
    if (ciData) {
      for (const row of ciData) {
        if (seen.has(row.repo) || row.repo === CRCR_HEALTH_REPO) continue;
        const level = (row.downstream_repo_level || "L2") as Level;
        if (level in result) {
          result[level].push({ repo: row.repo, oncalls: [] });
          seen.add(row.repo);
        }
      }
    }

    // Sort each level by pass rate (worst first); repos with no metrics sort last
    for (const level of LEVELS_ORDERED) {
      result[level].sort(
        (a, b) =>
          (metricsMap.get(a.repo)?.pass_rate ?? 1) -
          (metricsMap.get(b.repo)?.pass_rate ?? 1)
      );
    }

    return result;
  }, [allowlist, ciData, metricsMap]);

  const stats = useMemo(() => {
    if (!ciData || ciData.length === 0) return null;
    const ct = metricsMap.get(CRCR_HEALTH_REPO);

    const totalRepos = allowlist
      ? Object.values(allowlist).reduce(
          (s, arr) =>
            s +
            arr.filter((e: AllowlistEntry) => e.repo !== CRCR_HEALTH_REPO)
              .length,
          0
        )
      : ciData.filter((r) => r.repo !== CRCR_HEALTH_REPO).length;
    const levelBreakdown = (["L4", "L3", "L2", "L1"] as Level[])
      .map((l) => {
        const count =
          allowlist?.[l]?.filter(
            (e: AllowlistEntry) => e.repo !== CRCR_HEALTH_REPO
          ).length ?? 0;
        return count > 0 ? `${count} ${l}` : null;
      })
      .filter(Boolean)
      .join(" \u00b7 ");

    return {
      totalRuns: ct?.total ?? 0,
      runsSub: `last ${days} days \u00b7 pytorch/crcr-test`,
      failures: ct?.failures ?? 0,
      timedOut: ct?.timed_out ?? 0,
      totalRepos,
      reposSub: levelBreakdown || undefined,
    };
  }, [ciData, metricsMap, allowlist, days]);

  const isLoading = !ciData && !ciError && !allowlist && !alError;
  const hasError =
    ciError || alError || nightlyError || healthError || nightlyHealthError;

  return (
    <>
      <Head>
        <title>Cross-Repository CI Summary | PyTorch HUD</title>
      </Head>
      <Stack spacing={3} sx={{ p: 3, maxWidth: 1400, mx: "auto" }}>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Typography variant="h4">Cross-Repository CI Summary</Typography>
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel>Time Range</InputLabel>
            <Select
              value={days}
              label="Time Range"
              onChange={(e: SelectChangeEvent<number>) =>
                setDays(Number(e.target.value))
              }
            >
              <MenuItem value={1}>Last 24h</MenuItem>
              <MenuItem value={7}>Last 7 days</MenuItem>
              <MenuItem value={30}>Last 30 days</MenuItem>
            </Select>
          </FormControl>
        </Box>

        <Typography variant="body2" color="text.secondary">
          Relay health metrics from{" "}
          <Link
            href="https://github.com/pytorch/crcr-test"
            target="_blank"
            rel="noreferrer"
          >
            pytorch/crcr-test
          </Link>{" "}
          probes. To know more, check the HUD dashboard —{" "}
          <NextLink href="/crcr/pytorch/crcr-test" passHref legacyBehavior>
            <Link underline="hover">Pull Requests</Link>
          </NextLink>{" "}
          and{" "}
          <NextLink
            href="/crcr/pytorch/crcr-test?event=nightly"
            passHref
            legacyBehavior
          >
            <Link underline="hover">Nightly</Link>
          </NextLink>{" "}
          — or view{" "}
          <NextLink href="/crcr/metrics" passHref legacyBehavior>
            <Link underline="hover">success-rate trends</Link>
          </NextLink>
          .
        </Typography>

        {hasError && (
          <Typography color="error">
            {ciError?.message ||
              alError?.message ||
              nightlyError?.message ||
              healthError?.message ||
              nightlyHealthError?.message ||
              "Failed to load data"}
          </Typography>
        )}

        {isLoading && <Skeleton variant="rectangular" height={120} />}

        {stats && (
          <Stack spacing={2}>
            <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
              <CrcrTestHealthCard healthPrs={healthPrs} />
              <CrcrNightlyHealthCard nightlyJobs={nightlyHealthJobs} />
              <StatCard
                label="Total Probe Runs"
                value={stats.totalRuns}
                sub={stats.runsSub}
              />
            </Box>
            <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
              <StatCard
                label="Probe Failures"
                value={stats.failures}
                sub="pytorch/crcr-test failures"
              />
              <StatCard
                label="Registered Backends"
                value={stats.totalRepos}
                sub={stats.reposSub}
              />
              <StatCard
                label="Timed Out"
                value={stats.timedOut}
                sub="probes that failed to report completion"
              />
            </Box>
          </Stack>
        )}

        <Tabs
          value={activeTab}
          onChange={(_, v: EventTab) => setActiveTab(v)}
          sx={{ borderBottom: 1, borderColor: "divider" }}
        >
          <Tab
            label={
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                Pull Requests
                <Chip
                  label={
                    LEVELS_ORDERED.reduce(
                      (n, l) => n + reposByLevel[l].length,
                      0
                    ) || "–"
                  }
                  size="small"
                  variant="outlined"
                  sx={{ height: 20, fontSize: "0.75rem" }}
                />
              </Box>
            }
            value="pr"
          />
          <Tab
            label={
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                Nightly
                <Chip
                  label={nightlyRepoCount || "–"}
                  size="small"
                  variant="outlined"
                  sx={{ height: 20, fontSize: "0.75rem" }}
                />
              </Box>
            }
            value="nightly"
          />
        </Tabs>

        {activeTab === "pr" && (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Registered downstream repos sorted by pass rate (worst first).
              Click a row to see the per-downstream repo dashboard.
            </Typography>

            {LEVELS_ORDERED.map((level) => {
              const repos = reposByLevel[level];
              if (repos.length === 0) return null;
              const meta = LEVEL_META[level];

              return (
                <Box key={level}>
                  <Divider sx={{ mb: 2 }}>
                    <Typography variant="h6">{meta.label}</Typography>
                  </Divider>
                  {level === "L1" ? (
                    <L1Section repos={repos} />
                  ) : (
                    <CiHealthTable
                      level={level}
                      repos={repos}
                      metricsMap={metricsMap}
                    />
                  )}
                </Box>
              );
            })}

            {!isLoading &&
              LEVELS_ORDERED.every((l) => reposByLevel[l].length === 0) && (
                <Typography
                  color="text.secondary"
                  sx={{ py: 4, textAlign: "center" }}
                >
                  No CRCR backends registered. Add repos to{" "}
                  <Link
                    href="https://github.com/pytorch/pytorch/blob/main/.github/allowlist.yml"
                    target="_blank"
                  >
                    pytorch/pytorch/.github/allowlist.yml
                  </Link>{" "}
                  to get started.
                </Typography>
              )}
          </>
        )}

        {activeTab === "nightly" && (
          <>
            <Paper
              elevation={0}
              sx={{
                mt: 1,
                p: 2,
                bgcolor: "action.hover",
                borderLeft: "3px solid",
                borderColor: "info.main",
              }}
            >
              <Typography variant="body2">
                Nightly CI runs triggered daily from the{" "}
                <code>pytorch/pytorch</code> nightly branch HEAD. Results are
                reported via the CRCR callback pipeline.
              </Typography>
            </Paper>

            {visibleNightlyData.length > 0 ? (
              <>
                <Typography variant="h6" sx={{ mt: 2 }}>
                  Nightly CI Runs — Last {days} Days
                </Typography>
                <NightlyTable
                  nightlyData={visibleNightlyData}
                  days={days}
                />
              </>
            ) : (
              <Paper
                elevation={0}
                sx={{
                  mt: 2,
                  p: 3,
                  textAlign: "center",
                  border: "1px dashed",
                  borderColor: "divider",
                }}
              >
                <Typography variant="body2" color="text.secondary">
                  No nightly CI results reported yet. Repos will appear here
                  once their nightly workflows are set up and report back via
                  the callback action.
                </Typography>
              </Paper>
            )}
          </>
        )}
      </Stack>
    </>
  );
}
