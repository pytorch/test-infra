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
  Typography,
} from "@mui/material";
import { durationDisplay } from "components/common/TimeUtils";
import { fetcher } from "lib/GeneralUtils";
import Head from "next/head";
import NextLink from "next/link";
import { useState } from "react";
import useSWR from "swr";

interface CrcrSummaryRow {
  repo: string;
  downstream_repo_level: string;
  successes: number;
  failures: number;
  total: number;
  pass_rate: number;
  avg_duration_s: number;
  last_run: string;
}

function PassRateChip({ rate }: { rate: number }) {
  const pct = (rate * 100).toFixed(1) + "%";
  if (rate >= 0.95) return <Chip label={pct} color="success" size="small" />;
  if (rate >= 0.8) return <Chip label={pct} color="warning" size="small" />;
  return <Chip label={pct} color="error" size="small" />;
}

function CrcrSummaryTable({ days }: { days: number }) {
  const url = `/api/clickhouse/crcr_summary?parameters=${encodeURIComponent(
    JSON.stringify({ days: String(days) })
  )}`;
  const { data, error } = useSWR<CrcrSummaryRow[]>(url, fetcher, {
    refreshInterval: 60_000,
  });

  if (error) {
    return (
      <Typography color="error">
        Failed to load CRCR summary: {error.message}
      </Typography>
    );
  }
  if (!data) {
    return <Skeleton variant="rectangular" height={300} />;
  }
  if (data.length === 0) {
    return (
      <Typography color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
        No CRCR CI results in the last {days} days.
      </Typography>
    );
  }

  return (
    <TableContainer component={Paper} elevation={2}>
      <Table size="small">
        <TableHead>
          <TableRow>
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
          {data.map((row) => {
            const parts = row.repo?.split("/") ?? [];
            if (parts.length !== 2) return null;
            const [org, repo] = parts;
            return (
              <TableRow key={row.repo} hover>
                <TableCell>
                  <NextLink
                    href={`/crcr/${org}/${repo}`}
                    passHref
                    legacyBehavior
                  >
                    <Link underline="hover">{row.repo}</Link>
                  </NextLink>
                </TableCell>
                <TableCell align="center">
                  <Chip
                    label={row.downstream_repo_level || "–"}
                    size="small"
                    variant="outlined"
                  />
                </TableCell>
                <TableCell align="right">
                  <PassRateChip rate={row.pass_rate} />
                </TableCell>
                <TableCell align="right">{row.successes}</TableCell>
                <TableCell align="right">{row.failures}</TableCell>
                <TableCell align="right">{row.total}</TableCell>
                <TableCell align="right">
                  {durationDisplay(Math.round(row.avg_duration_s))}
                </TableCell>
                <TableCell align="right">
                  {new Date(row.last_run).toLocaleString()}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export default function CrcrSummaryPage() {
  const [days, setDays] = useState(7);

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
          Cross-repo CI health overview. Repos sorted by pass rate (worst
          first). Click a row to see the per-backend dashboard.
        </Typography>

        <CrcrSummaryTable days={days} />
      </Stack>
    </>
  );
}
