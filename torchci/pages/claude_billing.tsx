import { Box, Button, Container, Typography } from "@mui/material";
import Head from "next/head";
import { useDarkMode } from "../lib/DarkModeContext";

const CLAUDE_BILLING_DASHBOARD_ID = "9127e39ec5a7410ebb419fac06a08ca0";

export default function ClaudeBillingPage() {
  const { themeMode, darkMode } = useDarkMode();

  let chartTheme = "light";
  if (themeMode === "system") {
    chartTheme = darkMode ? "dark" : "light";
  } else {
    chartTheme = themeMode;
  }

  const dashboardUrl = `https://disz2yd9jqnwc.cloudfront.net/public-dashboards/${CLAUDE_BILLING_DASHBOARD_ID}?theme=${chartTheme}`;
  const grafanaUrl = `https://pytorchci.grafana.net/public-dashboards/${CLAUDE_BILLING_DASHBOARD_ID}`;

  return (
    <>
      <Head>
        <title>Claude Code Review Billing - PyTorch CI HUD</title>
      </Head>
      <Container maxWidth={false} sx={{ py: 2 }}>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            mb: 2,
          }}
        >
          <Typography variant="h4" component="h1">
            Claude Code Review Billing
          </Typography>
          <Button
            href={grafanaUrl}
            target="_blank"
            variant="outlined"
            size="small"
          >
            Open in Grafana
          </Button>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Track Claude AI usage costs for code review, issue triage, and other
          GitHub Actions workflows. Costs are tracked per invocation with
          breakdowns by workflow, user, and repository.
        </Typography>
        <Box
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            overflow: "hidden",
            height: "calc(100vh - 180px)",
            minHeight: "600px",
          }}
        >
          <iframe
            src={dashboardUrl}
            width="100%"
            height="100%"
            frameBorder="0"
            title="Claude Code Review Billing Dashboard"
            style={{ display: "block" }}
          />
        </Box>
      </Container>
    </>
  );
}
