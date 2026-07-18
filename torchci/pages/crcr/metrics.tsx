import {
  Box,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Select,
  SelectChangeEvent,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import {
  seriesWithInterpolatedTimes,
  TimeSeriesPanelWithData,
} from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { fetcher } from "lib/GeneralUtils";
import Head from "next/head";
import NextLink from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
dayjs.extend(utc);

interface SuccessRateRow {
  day: string;
  repo: string;
  successes: number;
  failures: number;
  timed_out: number;
  total: number;
  pass_rate: number;
}

function PassRateChart({
  data,
  days,
}: {
  data: SuccessRateRow[];
  days: number;
}) {
  const startTime = dayjs.utc().subtract(days, "day").startOf("day");
  const stopTime = dayjs.utc().endOf("day");

  const series = seriesWithInterpolatedTimes(
    data,
    startTime,
    stopTime,
    "day",
    "repo",
    "day",
    "pass_rate",
    true,
    true,
    "name",
    "line"
  );

  return (
    <Box sx={{ height: 420 }}>
      <TimeSeriesPanelWithData
        data={data}
        series={series}
        title="Pass Rate Over Time"
        groupByFieldName="repo"
        yAxisRenderer={(v: number) => `${(v * 100).toFixed(0)}%`}
        yAxisLabel="Pass Rate"
        additionalOptions={{
          yAxis: { min: 0, max: 1 },
        }}
        useUTC
      />
    </Box>
  );
}

function FailuresChart({
  data,
  days,
}: {
  data: SuccessRateRow[];
  days: number;
}) {
  const startTime = dayjs.utc().subtract(days, "day").startOf("day");
  const stopTime = dayjs.utc().endOf("day");

  const series = seriesWithInterpolatedTimes(
    data,
    startTime,
    stopTime,
    "day",
    "repo",
    "day",
    "failures",
    true,
    false,
    "name",
    "stacked_bar"
  );

  return (
    <Box sx={{ height: 420 }}>
      <TimeSeriesPanelWithData
        data={data}
        series={series}
        title="Failures Over Time"
        groupByFieldName="repo"
        yAxisRenderer={(v: number) => String(Math.round(v))}
        yAxisLabel="Failures"
        useUTC
      />
    </Box>
  );
}

function TotalRunsChart({
  data,
  days,
}: {
  data: SuccessRateRow[];
  days: number;
}) {
  const startTime = dayjs.utc().subtract(days, "day").startOf("day");
  const stopTime = dayjs.utc().endOf("day");

  const series = seriesWithInterpolatedTimes(
    data,
    startTime,
    stopTime,
    "day",
    "repo",
    "day",
    "total",
    true,
    false,
    "name",
    "stacked_bar"
  );

  return (
    <Box sx={{ height: 420 }}>
      <TimeSeriesPanelWithData
        data={data}
        series={series}
        title="Total Runs Over Time"
        groupByFieldName="repo"
        yAxisRenderer={(v: number) => String(Math.round(v))}
        yAxisLabel="Total Runs"
        useUTC
      />
    </Box>
  );
}

export default function CrcrMetricsPage() {
  const [days, setDays] = useState(30);

  const url = `/api/clickhouse/crcr_success_rate?parameters=${encodeURIComponent(
    JSON.stringify({ days: String(days) })
  )}`;
  const { data, error } = useSWR<SuccessRateRow[]>(url, fetcher, {
    refreshInterval: 5 * 60_000,
  });

  const repos = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.map((r) => r.repo))].sort();
  }, [data]);

  const isLoading = !data && !error;

  return (
    <>
      <Head>
        <title>CRCR Metrics | PyTorch HUD</title>
      </Head>
      <Stack spacing={3} sx={{ p: 3, maxWidth: 1400, mx: "auto" }}>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Typography variant="h4">CRCR Metrics</Typography>
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel>Time Range</InputLabel>
            <Select
              value={days}
              label="Time Range"
              onChange={(e: SelectChangeEvent<number>) =>
                setDays(Number(e.target.value))
              }
            >
              <MenuItem value={7}>Last 7 days</MenuItem>
              <MenuItem value={14}>Last 14 days</MenuItem>
              <MenuItem value={30}>Last 30 days</MenuItem>
              <MenuItem value={90}>Last 90 days</MenuItem>
            </Select>
          </FormControl>
        </Box>

        <Typography variant="body2" color="text.secondary">
          Success rate and failure trends for all CRCR-registered downstream
          repos.{" "}
          <NextLink href="/crcr" passHref legacyBehavior>
            <Link underline="hover">Back to CRCR Summary</Link>
          </NextLink>
        </Typography>

        {error && (
          <Typography color="error">
            {error.message || "Failed to load metrics data"}
          </Typography>
        )}

        {isLoading && (
          <Stack spacing={2}>
            <Skeleton variant="rectangular" height={420} />
            <Skeleton variant="rectangular" height={420} />
          </Stack>
        )}

        {data && (
          <Stack spacing={3}>
            <PassRateChart data={data} days={days} />
            <FailuresChart data={data} days={days} />
            <TotalRunsChart data={data} days={days} />
          </Stack>
        )}

        {data && repos.length > 0 && (
          <Box>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Repos in view ({repos.length}):
            </Typography>
            <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
              {repos.map((repo) => (
                <NextLink
                  key={repo}
                  href={`/crcr/${repo}`}
                  passHref
                  legacyBehavior
                >
                  <Link
                    underline="hover"
                    sx={{
                      fontSize: "0.85rem",
                      px: 1,
                      py: 0.25,
                      bgcolor: "action.hover",
                      borderRadius: 1,
                    }}
                  >
                    {repo}
                  </Link>
                </NextLink>
              ))}
            </Box>
          </Box>
        )}
      </Stack>
    </>
  );
}
