import {
  Alert,
  Box,
  Button,
  Link,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import NextLink from "next/link";
import type { ReactNode } from "react";
import { releaseErrorMessage } from "lib/releasePortal/api";

export function ReleasePage({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ maxWidth: 1200, mx: "auto", px: { xs: 2, sm: 3 }, py: 4 }}>
      <Stack spacing={3}>{children}</Stack>
    </Box>
  );
}

export function ReleaseLoading({
  title,
  rows = 3,
}: {
  title: string;
  rows?: number;
}) {
  return (
    <ReleasePage>
      <Box>
        <Typography component="h1" variant="h4" fontWeight={600}>
          {title}
        </Typography>
        <Typography color="text.secondary">Loading release data…</Typography>
      </Box>
      <Stack spacing={2} aria-label="Loading release data">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} variant="rounded" height={92} />
        ))}
      </Stack>
    </ReleasePage>
  );
}

export function ReleaseLoadError({
  resource,
  error,
  onRetry,
}: {
  resource: string;
  error: unknown;
  onRetry: () => Promise<void>;
}) {
  return (
    <ReleasePage>
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void onRetry()}>
            Retry
          </Button>
        }
      >
        Could not load {resource}: {releaseErrorMessage(error)}
      </Alert>
    </ReleasePage>
  );
}

export function ReleaseNotFound({
  version,
  knownVersions,
}: {
  version: string;
  knownVersions: string[];
}) {
  return (
    <ReleasePage>
      <Alert severity="warning">
        <Stack spacing={1}>
          <Typography component="h1" variant="h5">
            Release {version} not found
          </Typography>
          {knownVersions.length > 0 && (
            <Typography>Known: {knownVersions.join(", ")}</Typography>
          )}
          <Link component={NextLink} href="/release" underline="hover">
            All releases
          </Link>
        </Stack>
      </Alert>
    </ReleasePage>
  );
}
