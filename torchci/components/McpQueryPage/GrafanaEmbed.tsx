import React from "react";
import { Typography, Button, Box } from "@mui/material";
import { useDarkMode } from "../../lib/DarkModeContext";
import { GrafanaChartContainer, ChartHeader } from "./styles";

interface GrafanaEmbedProps {
  dashboardId: string;
}

export const GrafanaEmbed: React.FC<GrafanaEmbedProps> = ({ dashboardId }) => {
  const { themeMode, darkMode } = useDarkMode();

  let chartTheme = "light";
  if (themeMode === "system") {
    chartTheme = darkMode ? "dark" : "light";
  } else {
    chartTheme = themeMode;
  }

  const dashboardUrl = `https://disz2yd9jqnwc.cloudfront.net/public-dashboards/${dashboardId}?theme=${chartTheme}`;

  return (
    <GrafanaChartContainer>
      <ChartHeader>
        <Typography variant="subtitle2">Grafana Dashboard</Typography>
        <Button
          href={`https://pytorchci.grafana.net/public-dashboards/${dashboardId}`}
          target="_blank"
          size="small"
          variant="outlined"
        >
          Open in Grafana
        </Button>
      </ChartHeader>
      <Box sx={{ height: "640px", width: "100%" }}>
        <iframe
          src={dashboardUrl}
          width="100%"
          height="100%"
          frameBorder="0"
          title={`Grafana Dashboard ${dashboardId}`}
        />
      </Box>
    </GrafanaChartContainer>
  );
};