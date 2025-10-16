import { Chip, Divider, Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";
import {
  RenderRawContent,
  RenderStaticContent,
} from "components/benchmark/v3/components/common/RawContentDialog";
import dayjs from "dayjs";
import {
  BenchmarkRegressionBucketCounts,
  BenchmarkRegressionReport,
  STATUS_COLOR_MAP,
} from "../common";

export default function BenchmarkRegressionReportMetadataSection({
  data,
}: {
  data: any;
}) {
  return (
    <Box>
      <BenchmarkRegressionPrimarySignalSection data={data} />
      <Divider sx={{ my: 1 }} />
      <BenchmarkRegressionReportInformation report={data} />
      <Divider sx={{ my: 1 }} />
      <Stack direction="row" spacing={1}>
        <RenderRawContent
          data={data}
          title="Report Raw Json"
          buttonName="View Full Raw Data"
          type="json"
        />
        <RenderStaticContent
          data={data.policy}
          title="Regression Policy Configuration"
          buttonName="View Full Policy"
        />
      </Stack>
    </Box>
  );
}

function BenchmarkRegressionPrimarySignalSection({ data }: { data: any }) {
  return (
    <Box sx={{ mt: 1 }}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography>
          {" "}
          <strong>Status:</strong>
        </Typography>
        <Chip
          label={data.status}
          size="small"
          sx={{
            backgroundColor: STATUS_COLOR_MAP[data.status] ?? "none",
            color: "white",
            ml: 1,
          }}
        />
      </Stack>
      <BenchmarkRegressionBucketCounts report={data} />
    </Box>
  );
}

function BenchmarkRegressionReportInformation({
  report,
}: {
  report: BenchmarkRegressionReport;
}) {
  if (!report) return null;

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Report Information
      </Typography>
      <Stack spacing={0.5}>
        <Typography variant="body2">
          <strong>ID:</strong> {report.id}
        </Typography>
        <Typography variant="body2">
          <strong>Report Type:</strong> {report.report_id}
        </Typography>
        <Typography variant="body2">
          <strong>Type:</strong> {report.type}
        </Typography>
        <Typography variant="body2">
          <strong>Repo:</strong> <code>{report.repo}</code>
        </Typography>
        <Typography variant="body2">
          <strong>Last Record Commit:</strong>{" "}
          <code>{report.last_record_commit?.slice(0, 10)}</code>
        </Typography>
        <Typography variant="body2">
          <strong>Created At:</strong>{" "}
          {dayjs(report.created_at).toLocaleString()}
        </Typography>
        <Typography variant="body2">
          <strong>Last Record ts:</strong> {report.last_record_ts}
        </Typography>
      </Stack>
    </Box>
  );
}
