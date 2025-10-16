import { Divider, Paper, Typography } from "@mui/material";
import { Stack } from "@mui/system";
import { BenchmarkUIConfigHandler } from "lib/benchmark/store/benchmark_config_book";
import { BenchmarkReportFeatureNotification } from "../dataRender/components/benchmarkRegressionReport/BenchmarkReportFeatureNotification";
import { BenchmarkReportFeatureSidePanel } from "../dataRender/components/benchmarkRegressionReport/BenchmarkReportFeatureSidePanel";
import { CommitWorflowSelectSection } from "./components/commits/CommitWorkfowSelectSection";

export function BenchmarkTopBar({
  config,
  title = "",
}: {
  config: BenchmarkUIConfigHandler;
  title?: string;
}) {
  const reportFeature =
    config.raw.dataRender?.sideRender?.RegressionReportFeature;
  return (
    <Paper
      elevation={1} // adds subtle shadow (you can increase for stronger effect)
      sx={{
        height: 90,
        position: "sticky",
        top: 0,
        paddingTop: 2,
        zIndex: 1100,
        borderBottom: "1px solid",
        borderColor: "divider",
        px: 2,
        bgcolor: "background.paper", // ensures consistent opaque color with theme
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ height: "100%" }}
      >
        {title && (
          <>
            <Typography variant="subtitle1">{title}</Typography>
            <Divider orientation="vertical" flexItem sx={{ mx: 1 }} />
          </>
        )}
        <ReportFeature reportFeature={reportFeature} />
        <Divider orientation="vertical" flexItem sx={{ mx: 1 }} />
        <CommitWorflowSelectSection />
      </Stack>
    </Paper>
  );
}

function ReportFeature({ reportFeature }: { reportFeature: any }) {
  if (!reportFeature) {
    return null;
  }
  const config = reportFeature?.config;
  const report_id = config?.report_id;

  return (
    <>
      <BenchmarkReportFeatureSidePanel id={report_id} type={"list"} />
      <BenchmarkReportFeatureNotification report_id={report_id} />
    </>
  );
}
