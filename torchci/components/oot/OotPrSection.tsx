import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Chip,
  Link,
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
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { durationDisplay } from "components/common/TimeUtils";
import { fetcher } from "lib/GeneralUtils";
import useSWR from "swr";

interface OotPrResult {
  downstream_repo: string;
  workflow_name: string;
  job_name: string;
  run_attempt: number;
  status: string;
  conclusion: string;
  duration_seconds: number;
  workflow_run_url: string;
  artifact_url: string;
  started_at: string;
  queue_time: number | null;
  execution_time: number | null;
}

function conclusionColor(
  status: string,
  conclusion: string
): "success" | "error" | "warning" | "info" | "default" {
  if (status === "in_progress") return "info";
  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
      return "error";
    case "cancelled":
    case "timed_out":
      return "warning";
    default:
      return "default";
  }
}

function conclusionLabel(status: string, conclusion: string): string {
  if (status === "in_progress") return "running";
  return conclusion || status;
}

export default function OotPrSection({ prNumber }: { prNumber: number }) {
  const url = `/api/clickhouse/oot_pr_results?parameters=${encodeURIComponent(
    JSON.stringify({ pr: String(prNumber) })
  )}`;
  const { data, error } = useSWR<OotPrResult[]>(url, fetcher, {
    refreshInterval: 60_000,
  });

  if (error || !data || data.length === 0) return null;

  const successCount = data.filter(
    (r) => r.status === "completed" && r.conclusion === "success"
  ).length;
  const totalCompleted = data.filter(
    (r) => r.status === "completed"
  ).length;
  const inProgress = data.filter(
    (r) => r.status === "in_progress"
  ).length;

  const summaryText = [
    totalCompleted > 0
      ? `${successCount}/${totalCompleted} passed`
      : null,
    inProgress > 0 ? `${inProgress} running` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Accordion defaultExpanded={false} sx={{ mt: 2 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="subtitle1">
            <strong>Out-of-Tree Backends</strong>
          </Typography>
          <Typography variant="body2" color="text.secondary">
            ({summaryText})
          </Typography>
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>
                  <strong>Backend</strong>
                </TableCell>
                <TableCell>
                  <strong>Job</strong>
                </TableCell>
                <TableCell align="center">
                  <strong>Status</strong>
                </TableCell>
                <TableCell align="right">
                  <strong>Duration</strong>
                </TableCell>
                <TableCell>
                  <strong>Links</strong>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.map((row, i) => (
                <TableRow key={i} hover>
                  <TableCell>{row.downstream_repo}</TableCell>
                  <TableCell>{row.job_name}</TableCell>
                  <TableCell align="center">
                    <Chip
                      label={conclusionLabel(row.status, row.conclusion)}
                      color={conclusionColor(row.status, row.conclusion)}
                      size="small"
                    />
                  </TableCell>
                  <TableCell align="right">
                    {row.duration_seconds
                      ? durationDisplay(Math.round(row.duration_seconds))
                      : "–"}
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1}>
                      {row.workflow_run_url && (
                        <Link
                          href={row.workflow_run_url}
                          target="_blank"
                          rel="noopener"
                          variant="body2"
                        >
                          Run
                        </Link>
                      )}
                      {row.artifact_url && (
                        <Link
                          href={row.artifact_url}
                          target="_blank"
                          rel="noopener"
                          variant="body2"
                        >
                          Artifacts
                        </Link>
                      )}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </AccordionDetails>
    </Accordion>
  );
}
