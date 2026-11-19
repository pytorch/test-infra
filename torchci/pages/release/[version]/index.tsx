import {
  alpha,
  Breadcrumbs,
  Grid,
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
  ReleaseLinksRow,
  ReleaseStatCard,
} from "components/release/ReleaseComponents";
import {
  ReleaseLoadError,
  ReleaseLoading,
  ReleaseNotFound,
  ReleasePage,
} from "components/release/ReleasePage";
import type { ReleaseBoard, ReleaseIndex } from "lib/api/releases/types";
import {
  isReleaseNotFound,
  releaseIndexUrlForNotFound,
  ReleaseResource,
  useReleaseResource,
} from "lib/releasePortal/api";
import { isSafeReleaseUrl } from "lib/releasePortal/url";
import Head from "next/head";
import NextLink from "next/link";
import { useRouter } from "next/router";

function routeVersion(
  value: string | string[] | undefined
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

function lastCheckedLabel(lastChecked: string | null): string {
  if (lastChecked === null) {
    return "Not checked";
  }

  const date = new Date(lastChecked);
  if (Number.isNaN(date.getTime())) {
    return "Not checked";
  }

  return `${new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date)} UTC`;
}

export function ReleaseBoardPageContent({
  version,
  board,
  index,
}: {
  version: string | undefined;
  board: ReleaseResource<ReleaseBoard>;
  index: ReleaseResource<ReleaseIndex>;
}) {
  if (version === undefined) {
    return <ReleaseLoading title="Release portal" rows={2} />;
  }

  if (board.error !== undefined && board.data === undefined) {
    if (isReleaseNotFound(board.error)) {
      return (
        <ReleaseNotFound
          version={version}
          knownVersions={
            index.data?.releases.map((release) => release.version) ?? []
          }
        />
      );
    }
    return (
      <ReleaseLoadError
        resource={`release ${version}`}
        error={board.error}
        onRetry={board.retry}
      />
    );
  }
  if (board.data === undefined) {
    return <ReleaseLoading title={`Release ${version}`} rows={4} />;
  }

  const release = board.data;
  return (
    <ReleasePage>
      <Stack spacing={1}>
        <Breadcrumbs>
          <Link component={NextLink} href="/release" underline="hover">
            Releases
          </Link>
          <Typography color="text.primary">{release.version}</Typography>
        </Breadcrumbs>
        <Typography component="h1" variant="h4" fontWeight={600}>
          PyTorch {release.version} : {release.phase}
        </Typography>
        <Typography color="text.secondary">
          {release.type} release · {release.branch}
          {release.current_rc === null
            ? ""
            : ` · ${release.current_rc.toUpperCase()}`}
        </Typography>
        <ReleaseLinksRow links={release.links} />
      </Stack>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <ReleaseStatCard
            accent={release.stats.blocking > 0 ? "blocked" : "default"}
            label="Blocking"
            value={release.stats.blocking}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <ReleaseStatCard
            label="Steps done"
            value={`${release.stats.done} / ${release.stats.total}`}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <ReleaseStatCard
            label="Next milestone"
            value={
              release.stats.next_milestone === null
                ? "Not scheduled"
                : `${release.stats.next_milestone.name} · ${release.stats.next_milestone.date}`
            }
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <ReleaseStatCard
            label="Last checked"
            value={lastCheckedLabel(release.stats.last_checked)}
          />
        </Grid>
      </Grid>

      {release.phases.map((phase) => (
        <Paper
          component="section"
          key={phase.id}
          variant="outlined"
          sx={{ overflow: "hidden" }}
        >
          <Stack spacing={0.5} sx={{ p: 2.5, pb: 1.5 }}>
            <Typography component="h2" variant="h6" fontWeight={600}>
              Phase {phase.id}: {phase.name}
            </Typography>
            {phase.collapsed && (
              <Typography color="text.secondary" variant="body2">
                Every step in this phase is complete.
              </Typography>
            )}
          </Stack>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Step</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Owner</TableCell>
                  <TableCell>Due</TableCell>
                  <TableCell>Evidence</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {phase.steps.map((step) => {
                  const evidenceUrl = step.evidence?.url;
                  // a step for information has no check to show, so say what to look at
                  const manualLink = step.informational
                    ? step.manual?.link
                    : null;
                  return (
                    <TableRow
                      key={step.id}
                      // a red flag: the step is blocking (a nightly that is not green, a
                      // viable/strict that is far behind main)
                      sx={
                        step.blocking
                          ? {
                              bgcolor: (theme) =>
                                alpha(theme.palette.error.main, 0.14),
                            }
                          : undefined
                      }
                    >
                      <TableCell>
                        {step.id} · {step.name}
                      </TableCell>
                      <TableCell
                        sx={
                          step.blocking
                            ? { color: "error.main", fontWeight: 600 }
                            : undefined
                        }
                      >
                        {step.informational ? "info" : statusLabel(step.status)}
                      </TableCell>
                      <TableCell>{step.owner}</TableCell>
                      <TableCell>{step.due ?? "—"}</TableCell>
                      <TableCell>
                        {isSafeReleaseUrl(evidenceUrl) ? (
                          <Link
                            href={evidenceUrl}
                            target="_blank"
                            rel="noreferrer"
                            underline="hover"
                          >
                            {step.evidence?.text || "Open evidence"}
                          </Link>
                        ) : isSafeReleaseUrl(manualLink) ? (
                          <Link
                            href={manualLink}
                            target="_blank"
                            rel="noreferrer"
                            underline="hover"
                          >
                            {step.manual?.what_to_check}
                          </Link>
                        ) : (
                          step.evidence?.text ||
                          (step.informational
                            ? step.manual?.what_to_check
                            : null) ||
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      ))}
    </ReleasePage>
  );
}

export default function ReleaseBoardPage() {
  const router = useRouter();
  const version = routeVersion(router.query.version);
  const board = useReleaseResource<ReleaseBoard>(
    version === undefined
      ? null
      : `/api/releases/${encodeURIComponent(version)}`
  );
  const index = useReleaseResource<ReleaseIndex>(
    releaseIndexUrlForNotFound(version, board)
  );

  return (
    <>
      <Head>
        <title>
          {version === undefined
            ? "Release Portal | PyTorch CI HUD"
            : `Release ${version} | PyTorch CI HUD`}
        </title>
      </Head>
      <ReleaseBoardPageContent version={version} board={board} index={index} />
    </>
  );
}
