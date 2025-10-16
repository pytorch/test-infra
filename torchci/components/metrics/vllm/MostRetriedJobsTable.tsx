import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import {
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import { COLOR_ERROR, COLOR_HELP_ICON, COLOR_WARNING } from "./constants";

export default function MostRetriedJobsTable({
  data,
}: {
  data: any[] | undefined;
}) {
  if (!data || data.length === 0) {
    return (
      <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
        <Typography>No data available</Typography>
      </Paper>
    );
  }

  const topRetriedJobs = (data || []).filter(
    (job: any) => job.retried_count > 0
  );

  return (
    <Paper sx={{ p: 2, height: "100%", overflow: "auto" }} elevation={3}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 16,
        }}
      >
        <Typography variant="h6" sx={{ fontWeight: "bold" }}>
          Most Retried Jobs
        </Typography>
        <Tooltip
          title="Top 10 jobs by retry rate. Shows which jobs are retried most often, indicating flakiness or infrastructure sensitivity."
          arrow
          placement="top"
        >
          <HelpOutlineIcon
            sx={{ fontSize: "1.2rem", color: COLOR_HELP_ICON, cursor: "help" }}
          />
        </Tooltip>
      </div>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: "bold" }}>Job Name</TableCell>
              <TableCell align="center" sx={{ fontWeight: "bold" }}>
                Total Runs
              </TableCell>
              <TableCell align="center" sx={{ fontWeight: "bold" }}>
                Retries
              </TableCell>
              <TableCell align="center" sx={{ fontWeight: "bold" }}>
                Retry Rate
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {topRetriedJobs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} align="center">
                  <Typography sx={{ color: "text.secondary", py: 2 }}>
                    Loading retry data...
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              topRetriedJobs.map((job: any, index: number) => {
                const retryRate = job.retry_rate
                  ? (job.retry_rate * 100).toFixed(2) + "%"
                  : "0.00%";
                const rateValue = job.retry_rate || 0;
                const rateColor =
                  rateValue > 0.05
                    ? COLOR_ERROR
                    : rateValue > 0.02
                    ? COLOR_WARNING
                    : "inherit";

                return (
                  <TableRow key={index} hover>
                    <TableCell>
                      <Typography
                        sx={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: 250,
                        }}
                        title={job.job_name}
                      >
                        {job.job_name}
                      </Typography>
                    </TableCell>
                    <TableCell align="center">{job.total_runs}</TableCell>
                    <TableCell align="center" sx={{ color: COLOR_WARNING }}>
                      {job.retried_count}
                    </TableCell>
                    <TableCell
                      align="center"
                      sx={{ color: rateColor, fontWeight: "bold" }}
                    >
                      {retryRate}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}
