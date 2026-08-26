import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Paper,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import { durationDisplay } from "components/common/TimeUtils";
import { fetcherHandleError } from "lib/GeneralUtils";
import { decodeTestIdentity } from "lib/testIdentity";
import Head from "next/head";
import { useRouter } from "next/router";
import type { TestMetricsResponse } from "pages/api/tests/[id]/metrics";
import useSWR from "swr";

function MetricCard({
  label,
  value,
  percentage,
}: {
  label: string;
  value: string;
  percentage?: string;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2, textAlign: "center" }}>
      <Typography variant="overline" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h4" sx={{ fontWeight: 600 }}>
        {value}
      </Typography>
      {percentage && (
        <Typography variant="body2" color="text.secondary">
          {percentage}
        </Typography>
      )}
    </Paper>
  );
}

function HeaderField({ label, value }: { label: string; value: string }) {
  return (
    <Box component="span" sx={{ display: "block", minWidth: 0 }}>
      <Typography variant="overline" component="span" color="text.secondary">
        {label}
      </Typography>
      <Typography
        component="span"
        sx={{
          display: "block",
          fontFamily: "monospace",
          fontSize: "1.1rem",
          fontWeight: 600,
          fontStyle: value ? "normal" : "italic",
          lineHeight: 1.4,
          overflowWrap: "anywhere",
        }}
      >
        {value || "Not reported"}
      </Typography>
    </Box>
  );
}

export default function TestDetailsPage() {
  const router = useRouter();
  const id = typeof router.query.id === "string" ? router.query.id : null;
  const test = id ? decodeTestIdentity(id) : null;
  const metricsUrl =
    router.isReady && test && id
      ? `/api/tests/${encodeURIComponent(id)}/metrics`
      : null;
  const {
    data: metrics,
    error: metricsError,
    isLoading: metricsLoading,
    mutate: refreshMetrics,
  } = useSWR<TestMetricsResponse>(metricsUrl, fetcherHandleError, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
  if (!router.isReady) {
    return (
      <Stack
        alignItems="center"
        justifyContent="center"
        sx={{ minHeight: 320 }}
      >
        <CircularProgress />
      </Stack>
    );
  }

  if (!test) {
    return (
      <Box component="main" sx={{ maxWidth: 900, mx: "auto", p: 2 }}>
        <Alert severity="error">Invalid test identifier.</Alert>
      </Box>
    );
  }

  const totalRuns = metrics?.totalRuns.toLocaleString("en-US") ?? "0";
  const runCount = (count: number) =>
    `${count.toLocaleString("en-US")} / ${totalRuns}`;
  const runPercentage = (count: number) =>
    metrics && metrics.totalRuns > 0
      ? `${((count / metrics.totalRuns) * 100).toFixed(1)}% of total`
      : "N/A";
  const metricCards = metrics
    ? [
        {
          label: "Avg successful duration",
          value:
            metrics.averageDurationSeconds === null
              ? "N/A"
              : durationDisplay(metrics.averageDurationSeconds),
        },
        {
          label: "Successful runs",
          value: runCount(metrics.successfulRuns),
          percentage: runPercentage(metrics.successfulRuns),
        },
        {
          label: "Failures",
          value: runCount(metrics.failureRuns),
          percentage: runPercentage(metrics.failureRuns),
        },
        {
          label: "Skips",
          value: runCount(metrics.skippedRuns),
          percentage: runPercentage(metrics.skippedRuns),
        },
      ]
    : [];

  return (
    <>
      <Head>
        <title>{test.name || "Test"} | PyTorch CI</title>
      </Head>
      <Box component="main" sx={{ maxWidth: 1100, mx: "auto", p: 2 }}>
        <Box
          component="header"
          sx={{ mb: 3, pb: 3, borderBottom: 1, borderColor: "divider" }}
        >
          <Box
            component="h1"
            sx={{
              display: "grid",
              gridTemplateColumns: {
                xs: "minmax(0, 1fr)",
                md: "repeat(3, minmax(0, 1fr))",
              },
              gap: { xs: 1.5, md: 3 },
              m: 0,
            }}
          >
            <HeaderField label="File" value={test.file} />
            <HeaderField label="Classname" value={test.classname} />
            <HeaderField label="Name" value={test.name} />
          </Box>
        </Box>

        <Box component="section">
          <Typography variant="h6" component="h2" sx={{ mb: 1.5 }}>
            Last 30 days
          </Typography>
          {metricsError ? (
            <Alert
              severity="error"
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => void refreshMetrics()}
                >
                  Retry
                </Button>
              }
            >
              Unable to load test metrics. Please try again.
            </Alert>
          ) : (
            <>
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: {
                    xs: "1fr",
                    sm: "repeat(2, minmax(0, 1fr))",
                    md: "repeat(4, minmax(0, 1fr))",
                  },
                  gap: 2,
                }}
              >
                {metricsLoading || !metrics
                  ? Array.from({ length: 4 }, (_, index) => (
                      <Skeleton key={index} variant="rounded" height={104} />
                    ))
                  : metricCards.map((metric) => (
                      <MetricCard key={metric.label} {...metric} />
                    ))}
              </Box>
              {!metricsLoading && metrics?.totalRuns === 0 && (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ mt: 1.5 }}
                >
                  No runs recorded in the past 30 days.
                </Typography>
              )}
            </>
          )}
        </Box>
      </Box>
    </>
  );
}
