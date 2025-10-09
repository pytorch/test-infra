import { Paper, Typography } from "@mui/material";
import { Stack } from "@mui/system";
import { BenchmarkUI } from "../../configs/configBook";
import { BenchmarkReportFeatureSidePanel } from "../dataRender/components/benchmarkRegressionReport/BenchmarkReportFeatureSidePanel";

export function BenchmarkTopBar({
  config,
  title = "Benchmark",
}: {
  config: BenchmarkUI;
  title?: string;
}) {
  const reportFeature =
    config.raw.dataRender?.sideRender?.RegressionReportFeature;
  return (
    <Paper
      elevation={1} // adds subtle shadow (you can increase for stronger effect)
      sx={{
        height: 56,
        position: "sticky",
        top: 0,
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
        <Typography variant="subtitle1">{title}</Typography>
        <ReportFeature reportFeature={reportFeature} />
      </Stack>
    </Paper>
  );
}

function ReportFeature({ reportFeature }: { reportFeature: any }) {
  if (!reportFeature) {
    return null;
  }
  const config = reportFeature?.config;
  return (
    <BenchmarkReportFeatureSidePanel id={config?.report_id} type={"list"} />
  );
}
