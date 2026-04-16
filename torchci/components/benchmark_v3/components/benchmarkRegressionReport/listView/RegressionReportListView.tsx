import { Box, Button, Card, Chip, Stack, Typography } from "@mui/material";
import dayjs from "dayjs";
import { useRouter } from "next/router";
import { useState } from "react";
import {
  BenchmarkRegressionBucketCounts,
  BenchmarkRegressionReport,
  STATUS_COLOR_MAP,
} from "../common";

interface RegressionReportListProps {
  reports: BenchmarkRegressionReport[];
  hasNext?: boolean;
  fetchNext?: () => Promise<void>;
}

export default function RegressionReportList({
  reports,
  hasNext = false,
  fetchNext,
}: RegressionReportListProps) {
  const [loadingNext, setLoadingNext] = useState(false);

  const router = useRouter();

  const navigateToSingleReport = (id: string) => {
    router.push(`/benchmark/regression/report/${id}`);
  };

  const handleLoadMore = async () => {
    if (!fetchNext) return;
    setLoadingNext(true);
    try {
      await fetchNext();
    } finally {
      setLoadingNext(false);
    }
  };

  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h5" gutterBottom>
        Regression Reports
      </Typography>
      <Stack spacing={1.5}>
        {reports.map((r) => {
          return (
            <Card
              key={r.id}
              variant="outlined"
              sx={{
                px: 1.5,
                py: 1,
                borderRadius: 1.5,
                "&:hover": { borderColor: "primary.main", bgcolor: "#fafafa" },
              }}
            >
              <Stack direction="row" alignItems="center" spacing={1.5}>
                <Chip
                  label={r.status}
                  size="small"
                  sx={{
                    backgroundColor: STATUS_COLOR_MAP[r.status] ?? "none",
                    color: "white",
                  }}
                />
                <Button
                  size="small"
                  onClick={() => navigateToSingleReport(r.id)}
                >
                  View Report Details
                </Button>
              </Stack>
              <BenchmarkRegressionBucketCounts report={r} />
              <Stack direction="row" spacing={2} sx={{ mt: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  Date: {dayjs(r.created_at).toLocaleString()}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Id: {r.id}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Repo: {r.repo}
                </Typography>
              </Stack>
            </Card>
          );
        })}
      </Stack>

      {hasNext && (
        <Box sx={{ textAlign: "center", mt: 2 }}>
          <Button
            variant="outlined"
            onClick={handleLoadMore}
            disabled={loadingNext}
          >
            {loadingNext ? "Loading..." : "Load more"}
          </Button>
        </Box>
      )}
    </Box>
  );
}
