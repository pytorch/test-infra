import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Link,
  Stack,
  Typography,
} from "@mui/material";

export interface RelayHealthJob {
  jobName: string;
  status: string;
  conclusion: string | null;
  startedAt: string;
  completedAt?: string | null;
  workflowRunUrl: string | null;
  checkRunId: string | null;
  isOverdue?: boolean;
}

export interface RelayHealthRun {
  label: string;
  url: string;
  jobs: RelayHealthJob[];
}

export function isExpectedHealthOutcome(job: RelayHealthJob): boolean {
  return (
    (job.jobName.includes("xfail") && job.conclusion === "failure") ||
    (job.jobName.includes("xcancel") && job.conclusion === "cancelled") ||
    (job.jobName.includes("xtimeout") && job.conclusion === "timed_out")
  );
}

export function isHealthJobPassing(job: RelayHealthJob): boolean {
  return (
    job.status === "completed" &&
    (job.conclusion === "success" || isExpectedHealthOutcome(job))
  );
}

export function workflowJobUrl(job: RelayHealthJob): string | null {
  if (!job.workflowRunUrl) return null;
  return job.checkRunId
    ? `${job.workflowRunUrl}/job/${job.checkRunId}`
    : job.workflowRunUrl;
}

function jobState(job: RelayHealthJob): string {
  if (job.isOverdue) return "overdue in progress";
  if (job.status !== "completed") return job.status;
  return job.conclusion ?? "completed";
}

function attentionJobs(jobs: RelayHealthJob[]): RelayHealthJob[] {
  return jobs.filter((job) => !isHealthJobPassing(job));
}

export default function RelayHealthDetailsDialog({
  open,
  onClose,
  title,
  runs,
  loading = false,
  error = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  runs: RelayHealthRun[];
  loading?: boolean;
  error?: boolean;
}) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers>
        {error ? (
          <Typography color="error.main">
            Unable to load health details. Please try again.
          </Typography>
        ) : loading ? (
          <Typography color="text.secondary">
            Loading health details…
          </Typography>
        ) : runs.length === 0 ? (
          <Typography color="text.secondary">
            No health details found.
          </Typography>
        ) : (
          <Stack divider={<Divider flexItem />} spacing={1.5}>
            {runs.map((run) => {
              const jobsNeedingAttention = attentionJobs(run.jobs);
              const passingJobs = run.jobs.filter(isHealthJobPassing).length;
              return (
                <Box key={run.label}>
                  <Link href={run.url} target="_blank" rel="noopener">
                    {run.label}
                  </Link>
                  <Typography variant="body2" color="text.secondary">
                    {passingJobs}/{run.jobs.length} jobs passed
                  </Typography>
                  {jobsNeedingAttention.length === 0 ? (
                    <Typography variant="body2" color="success.main">
                      No unexpected job results
                    </Typography>
                  ) : (
                    jobsNeedingAttention.map((job) => {
                      const url = workflowJobUrl(job);
                      const timestamp = job.completedAt ?? job.startedAt;
                      const text = `${job.jobName}: ${jobState(
                        job
                      )} · ${timestamp}`;
                      const color =
                        job.status === "in_progress" && !job.isOverdue
                          ? "warning.main"
                          : "error.main";
                      return url ? (
                        <Link
                          key={`${job.jobName}-${job.startedAt}`}
                          href={url}
                          target="_blank"
                          rel="noopener"
                          display="block"
                          color={color}
                        >
                          {text}
                        </Link>
                      ) : (
                        <Typography
                          key={`${job.jobName}-${job.startedAt}`}
                          variant="body2"
                          color={color}
                        >
                          {text}
                        </Typography>
                      );
                    })
                  )}
                </Box>
              );
            })}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
