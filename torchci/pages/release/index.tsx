import { Link, Paper, Stack, Typography } from "@mui/material";
import {
  ReleaseLoadError,
  ReleaseLoading,
  ReleasePage,
} from "components/release/ReleasePage";
import type { ReleaseIndex } from "lib/api/releases/types";
import { ReleaseResource, useReleaseResource } from "lib/releasePortal/api";
import Head from "next/head";
import NextLink from "next/link";

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

export function ReleaseIndexPageContent({
  resource,
}: {
  resource: ReleaseResource<ReleaseIndex>;
}) {
  if (resource.error !== undefined && resource.data === undefined) {
    return (
      <ReleaseLoadError
        resource="releases"
        error={resource.error}
        onRetry={resource.retry}
      />
    );
  }
  if (resource.data === undefined) {
    return <ReleaseLoading title="PyTorch releases" />;
  }

  const { active, releases } = resource.data;
  return (
    <ReleasePage>
      <Stack spacing={1}>
        <Typography component="h1" variant="h4" fontWeight={600}>
          PyTorch releases
        </Typography>
        <Typography color="text.secondary">
          Current release progress, evidence, and artifacts.
        </Typography>
      </Stack>

      {active.length > 0 && (
        <Stack spacing={0.5}>
          <Typography variant="subtitle1" fontWeight={600}>
            Releases in flight
          </Typography>
          <Typography color="text.secondary" variant="body2">
            {active
              .map((release) => `${release.version} — ${release.phase}`)
              .join(" · ")}
          </Typography>
        </Stack>
      )}

      {releases.length === 0 ? (
        <Typography color="text.secondary">
          No release data has been recorded yet.
        </Typography>
      ) : (
        <Stack
          component="ul"
          spacing={2}
          sx={{ p: 0, m: 0, listStyle: "none" }}
        >
          {releases.map((release) => (
            <Paper
              component="li"
              key={release.version}
              variant="outlined"
              sx={{ p: 2.5 }}
            >
              <Stack spacing={1}>
                <Stack direction="row" justifyContent="space-between" gap={2}>
                  <Typography variant="h6" fontWeight={600}>
                    {release.version}
                  </Typography>
                  <Typography color="text.secondary" variant="body2">
                    {release.type} · {statusLabel(release.status)}
                  </Typography>
                </Stack>
                <Typography color="text.secondary" variant="body2">
                  {release.phase} · {release.progress.done}/
                  {release.progress.total} steps done
                  {release.ga_date === null
                    ? " · GA date to be confirmed"
                    : ` · GA ${release.ga_date}`}
                </Typography>
                <Link
                  component={NextLink}
                  href={`/release/${release.version}`}
                  underline="hover"
                >
                  Open release board
                </Link>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}
    </ReleasePage>
  );
}

export default function ReleaseIndexPage() {
  const resource = useReleaseResource<ReleaseIndex>("/api/releases");
  return (
    <>
      <Head>
        <title>PyTorch Releases | PyTorch CI HUD</title>
      </Head>
      <ReleaseIndexPageContent resource={resource} />
    </>
  );
}
