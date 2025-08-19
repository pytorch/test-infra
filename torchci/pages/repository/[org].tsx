import { useRouter } from "next/router";
import { useSession } from "next-auth/react";
import { useEffect, useState, useCallback } from "react";
import { signIn } from "next-auth/react";
import { 
  Box, 
  Typography, 
  Button, 
  Paper,
  CircularProgress,
  Container,
  Alert
} from "@mui/material";
import { useSetTitle } from "components/layout/DynamicTitle";

// Define permission states
type PermissionState = "unchecked" | "checking" | "sufficient" | "insufficient";

export default function RepositoryPage() {
  const router = useRouter();
  const { org } = router.query;
  const { data: session, status } = useSession();
  const [permissionState, setPermissionState] = useState<PermissionState>("unchecked");

  useSetTitle(`Repository: ${org}`);

  // Check if user has bypass cookie (similar to TorchAgentPage)
  const hasAuthCookie = useCallback(() => {
    if (typeof window !== "undefined") {
      return document.cookie.includes("GRAFANA_MCP_AUTH_TOKEN");
    }
    return false;
  }, []);

  const checkUserPermissions = useCallback(async () => {
    if (
      !session?.user ||
      hasAuthCookie() ||
      permissionState !== "unchecked"
    )
      return;

    setPermissionState("checking");
    try {
      // Make a simple API call to check permissions
      const response = await fetch("/api/torchagent-check-permissions", {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (response.status === 403) {
        setPermissionState("insufficient");
      } else if (!response.ok) {
        // For 500 errors or other issues, also show insufficient permissions
        setPermissionState("insufficient");
      } else {
        setPermissionState("sufficient");
      }
    } catch (error) {
      console.error("Error checking permissions:", error);
      setPermissionState("insufficient");
    }
  }, [session?.user, permissionState, hasAuthCookie]);

  useEffect(() => {
    if (session?.user) {
      // Only check permissions if we haven't checked yet
      if (permissionState === "unchecked") {
        checkUserPermissions();
      }
    }
  }, [session?.user, permissionState, checkUserPermissions]);

  // Loading state
  if (status === "loading" || permissionState === "checking") {
    return (
      <Container maxWidth="md" sx={{ mt: 4 }}>
        <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
          <Box textAlign="center">
            <CircularProgress sx={{ mb: 2 }} />
            <Typography variant="body1">
              {status === "loading" ? "Loading..." : "Checking permissions..."}
            </Typography>
          </Box>
        </Box>
      </Container>
    );
  }

  // Not signed in - show sign in prompt
  if (!session?.user && !hasAuthCookie()) {
    return (
      <Container maxWidth="md" sx={{ mt: 4 }}>
        <Paper sx={{ p: 4, textAlign: "center" }}>
          <Typography variant="h4" gutterBottom>
            Authentication Required
          </Typography>
          <Typography variant="body1" sx={{ mb: 2 }}>
            You must be logged in with write permissions to pytorch/pytorch to
            access this tool.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Please sign in with GitHub to continue.
          </Typography>
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
            }}
          >
            <Button
              variant="contained"
              color="primary"
              size="large"
              onClick={() => signIn()}
              sx={{ minWidth: "200px" }}
            >
              Sign In
            </Button>
            <Typography
              variant="body2"
              color="text.secondary"
              component="a"
              href="https://forms.gle/SoLgaCucjJqc6F647"
              target="_blank"
              rel="noopener noreferrer"
              sx={{
                textDecoration: "underline",
                "&:hover": {
                  textDecoration: "none",
                },
              }}
            >
              Don't have GitHub account? Request access here
            </Typography>
          </Box>
        </Paper>
      </Container>
    );
  }

  // Check if user is authenticated but has insufficient permissions
  if (
    session?.user &&
    !hasAuthCookie() &&
    permissionState === "insufficient"
  ) {
    return (
      <Container maxWidth="md" sx={{ mt: 4 }}>
        <Paper sx={{ p: 4, textAlign: "center" }}>
          <Typography variant="h4" gutterBottom>
            Insufficient Permissions
          </Typography>
          <Typography variant="body1" sx={{ mb: 2 }}>
            You are signed in as{" "}
            <strong>{session.user.name || session.user.email}</strong>
            , but you need write permissions to pytorch/pytorch to access this
            tool.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Please request access to continue.
          </Typography>
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
            }}
          >
            <Typography
              variant="body2"
              color="text.secondary"
              component="a"
              href="https://forms.gle/SoLgaCucjJqc6F647"
              target="_blank"
              rel="noopener noreferrer"
              sx={{
                textDecoration: "underline",
                "&:hover": {
                  textDecoration: "none",
                },
              }}
            >
              Request access here
            </Typography>
          </Box>
        </Paper>
      </Container>
    );
  }

  // User has sufficient permissions - show the repository page content
  return (
    <Container maxWidth="lg" sx={{ mt: 4 }}>
      <Typography variant="h3" gutterBottom>
        Repository: {org}
      </Typography>
      
      <Alert severity="info" sx={{ mb: 3 }}>
        Welcome to the repository page for <strong>{org}</strong>. 
        This page requires authentication and write permissions to pytorch/pytorch.
      </Alert>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="h5" gutterBottom>
          Repository Information
        </Typography>
        <Typography variant="body1" paragraph>
          Organization: <strong>{org}</strong>
        </Typography>
        <Typography variant="body2" color="text.secondary">
          This is a secured page that demonstrates authentication integration.
          Only users with write permissions to pytorch/pytorch can access this content.
        </Typography>
      </Paper>

      {/* Example section showing that this could contain sensitive info */}
      <Paper sx={{ p: 3 }}>
        <Typography variant="h5" gutterBottom>
          Protected Features
        </Typography>
        <Typography variant="body1" paragraph>
          This section could contain sensitive repository information that should
          only be accessible to authorized users.
        </Typography>
        <Box sx={{ mt: 2 }}>
          <Button
            variant="outlined"
            onClick={() => router.push(`/api/runners/${org}`)}
            target="_blank"
          >
            View Runners API
          </Button>
        </Box>
      </Paper>
    </Container>
  );
}