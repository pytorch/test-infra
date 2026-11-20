import {
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import {
  ReleaseStatCard,
  ReleaseStatusChip,
} from "components/release/ReleaseComponents";
import {
  ReleaseLoadError,
  ReleaseLoading,
  ReleasePage,
} from "components/release/ReleasePage";
import type { ReleaseIndex } from "lib/api/releases/types";
import { ReleaseResource, useReleaseResource } from "lib/releasePortal/api";
import Head from "next/head";
import NextLink from "next/link";

function releaseBoardUrl(version: string) {
  return `/release/${version}`;
}

function nextMilestoneLabel(
  milestone: ReleaseIndex["active"][number]["next_milestone"]
) {
  return milestone === null
    ? "Not scheduled"
    : `${milestone.name} · ${milestone.date}`;
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
  const releasesByVersion = new Map(
    releases.map((release) => [release.version, release])
  );
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
        <Stack spacing={1.5}>
          <Typography variant="subtitle1" fontWeight={600}>
            Active releases
          </Typography>
          {active.map((activeRelease) => {
            const release = releasesByVersion.get(activeRelease.version);
            return (
              <Paper
                key={activeRelease.version}
                variant="outlined"
                sx={{ p: 2 }}
              >
                <Stack spacing={1.5}>
                  <Stack
                    alignItems={{ sm: "center" }}
                    direction={{ xs: "column", sm: "row" }}
                    justifyContent="space-between"
                    spacing={0.5}
                  >
                    <Typography variant="h6" fontWeight={600}>
                      <Link
                        component={NextLink}
                        href={releaseBoardUrl(activeRelease.version)}
                        underline="hover"
                      >
                        PyTorch {activeRelease.version}
                      </Link>
                    </Typography>
                    <Typography color="text.secondary" variant="body2">
                      {activeRelease.phase}
                    </Typography>
                  </Stack>
                  <Stack direction="row" flexWrap="wrap" gap={1.5}>
                    <ReleaseStatCard
                      accent={
                        activeRelease.blocking > 0 ? "blocked" : "default"
                      }
                      label="Blocking"
                      value={activeRelease.blocking}
                    />
                    <ReleaseStatCard
                      label="Steps complete"
                      value={
                        release === undefined
                          ? "Not recorded"
                          : `${release.progress.done}/${release.progress.total}`
                      }
                    />
                    <ReleaseStatCard
                      label="Next milestone"
                      value={nextMilestoneLabel(activeRelease.next_milestone)}
                    />
                  </Stack>
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      )}

      {releases.length === 0 ? (
        <Typography color="text.secondary">
          No release data has been recorded yet.
        </Typography>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table aria-label="PyTorch releases" size="small">
            <TableHead>
              <TableRow>
                <TableCell>Release</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Branch</TableCell>
                <TableCell>GA date</TableCell>
                <TableCell>Progress</TableCell>
                <TableCell>Phase</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {releases.map((release) => (
                <TableRow
                  aria-label={`Open release ${release.version} board`}
                  hover
                  key={release.version}
                  onClick={() => {
                    window.location.assign(releaseBoardUrl(release.version));
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.target === event.currentTarget &&
                      (event.key === "Enter" || event.key === " ")
                    ) {
                      event.preventDefault();
                      window.location.assign(releaseBoardUrl(release.version));
                    }
                  }}
                  sx={{ cursor: "pointer" }}
                  tabIndex={0}
                >
                  <TableCell component="th" scope="row">
                    <Link
                      component={NextLink}
                      href={releaseBoardUrl(release.version)}
                      onClick={(event) => event.stopPropagation()}
                      underline="hover"
                    >
                      {release.version}
                    </Link>
                  </TableCell>
                  <TableCell>{release.type}</TableCell>
                  <TableCell>{release.branch}</TableCell>
                  <TableCell>{release.ga_date ?? "To be confirmed"}</TableCell>
                  <TableCell>
                    {release.progress.done}/{release.progress.total}
                  </TableCell>
                  <TableCell>{release.phase}</TableCell>
                  <TableCell>
                    <ReleaseStatusChip status={release.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
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
