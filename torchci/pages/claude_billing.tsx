import {
  Box,
  Button,
  CircularProgress,
  Container,
  Typography,
} from "@mui/material";
import { signIn, useSession } from "next-auth/react";
import Head from "next/head";
import { useCallback, useEffect, useState } from "react";
import { useDarkMode } from "../lib/DarkModeContext";

const CLAUDE_BILLING_DASHBOARD_ID = "9127e39ec5a7410ebb419fac06a08ca0";

export default function ClaudeBillingPage() {
  const { themeMode, darkMode } = useDarkMode();
  const session = useSession();
  const [permissionState, setPermissionState] = useState<
    "unchecked" | "checking" | "sufficient" | "insufficient"
  >("unchecked");

  const checkUserPermissions = useCallback(async () => {
    if (!session.data?.user || permissionState !== "unchecked") return;

    setPermissionState("checking");
    try {
      const response = await fetch("/api/torchagent-check-permissions", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (response.ok) {
        setPermissionState("sufficient");
      } else {
        setPermissionState("insufficient");
      }
    } catch (error) {
      console.error("Error checking permissions:", error);
      setPermissionState("insufficient");
    }
  }, [session.data?.user, permissionState]);

  useEffect(() => {
    if (session.data?.user && permissionState === "unchecked") {
      checkUserPermissions();
    }
  }, [session.data?.user, permissionState, checkUserPermissions]);

  let chartTheme = "light";
  if (themeMode === "system") {
    chartTheme = darkMode ? "dark" : "light";
  } else {
    chartTheme = themeMode;
  }

  const dashboardUrl = `https://disz2yd9jqnwc.cloudfront.net/public-dashboards/${CLAUDE_BILLING_DASHBOARD_ID}?theme=${chartTheme}`;
  const grafanaUrl = `https://pytorchci.grafana.net/public-dashboards/${CLAUDE_BILLING_DASHBOARD_ID}`;

  // Loading state
  if (session.status === "loading" || permissionState === "checking") {
    return (
      <>
        <Head>
          <title>Claude Code Review Billing - PyTorch CI HUD</title>
        </Head>
        <Container
          maxWidth={false}
          sx={{
            py: 10,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <CircularProgress />
          <Typography variant="h6" sx={{ mt: 2 }}>
            {session.status === "loading"
              ? "Checking authentication..."
              : "Checking permissions..."}
          </Typography>
        </Container>
      </>
    );
  }

  // Unauthenticated
  if (
    session.status === "unauthenticated" ||
    !session.data?.user ||
    !(session.data as any)?.accessToken
  ) {
    return (
      <>
        <Head>
          <title>Claude Code Review Billing - PyTorch CI HUD</title>
        </Head>
        <Container
          maxWidth={false}
          sx={{
            py: 10,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <Typography variant="h4" gutterBottom>
            Authentication Required
          </Typography>
          <Typography variant="body1" sx={{ mb: 2 }}>
            You must be signed in with write permissions to pytorch/pytorch to
            view Claude billing data.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Please sign in with GitHub to continue.
          </Typography>
          <Button
            variant="contained"
            color="primary"
            size="large"
            onClick={() => signIn()}
            sx={{ minWidth: "200px" }}
          >
            Sign In
          </Button>
        </Container>
      </>
    );
  }

  // Insufficient permissions
  if (permissionState === "insufficient") {
    return (
      <>
        <Head>
          <title>Claude Code Review Billing - PyTorch CI HUD</title>
        </Head>
        <Container
          maxWidth={false}
          sx={{
            py: 10,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <Typography variant="h4" gutterBottom>
            Insufficient Permissions
          </Typography>
          <Typography variant="body1" sx={{ mb: 2 }}>
            You are signed in as{" "}
            <strong>{session.data.user.name || session.data.user.email}</strong>
            , but you need write permissions to pytorch/pytorch to view this
            page.
          </Typography>
          <Box
            sx={{
              display: "flex",
              gap: 2,
              justifyContent: "center",
              flexWrap: "wrap",
            }}
          >
            <Button
              variant="contained"
              color="primary"
              component="a"
              href="https://forms.gle/SoLgaCucjJqc6F647"
              target="_blank"
              rel="noopener noreferrer"
            >
              Request Access
            </Button>
            <Button
              variant="outlined"
              color="secondary"
              onClick={() => {
                setPermissionState("unchecked");
                checkUserPermissions();
              }}
            >
              Try Again
            </Button>
          </Box>
        </Container>
      </>
    );
  }

  // Authorized — show the dashboard
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
            Claude Code Review — Estimated Costs
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
          Estimated Claude AI usage costs for code review, issue triage, and
          other GitHub Actions workflows, calculated from token counts in public
          GitHub Actions logs multiplied by{" "}
          <a
            href="https://www.anthropic.com/pricing"
            target="_blank"
            rel="noopener noreferrer"
          >
            Anthropic&apos;s list prices
          </a>
          . These figures do not reflect actual billing and may differ from
          invoiced amounts. Breakdowns are shown per invocation, workflow, user,
          and repository.
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
