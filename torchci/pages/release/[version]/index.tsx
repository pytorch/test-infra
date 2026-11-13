import {
  Breadcrumbs,
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
  ReleaseLoadError,
  ReleaseLoading,
  ReleaseNotFound,
  ReleasePage,
} from "components/release/ReleasePage";
import type { ReleaseBoard, ReleaseIndex } from "lib/api/releases/types";
import {
  isReleaseNotFound,
  ReleaseResource,
  useReleaseResource,
} from "lib/releasePortal/api";
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
          Release {release.version}
        </Typography>
        <Typography color="text.secondary">
          {release.type} release · {release.branch}
          {release.current_rc === null ? "" : ` · ${release.current_rc}`}
        </Typography>
      </Stack>

      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Stack spacing={0.75}>
          <Typography fontWeight={600}>
            {release.stats.done}/{release.stats.total} steps done ·{" "}
            {release.stats.blocking} blocking
          </Typography>
          <Typography color="text.secondary" variant="body2">
            {release.stats.next_milestone === null
              ? "No upcoming milestone is recorded."
              : `Next milestone: ${release.stats.next_milestone.name} on ${release.stats.next_milestone.date}.`}
          </Typography>
          <Link
            component={NextLink}
            href={`/release/${release.version}/artifacts`}
            underline="hover"
          >
            View release artifacts
          </Link>
        </Stack>
      </Paper>

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
                {phase.steps.map((step) => (
                  <TableRow key={step.id}>
                    <TableCell>
                      {step.id} · {step.name}
                    </TableCell>
                    <TableCell>{statusLabel(step.status)}</TableCell>
                    <TableCell>{step.owner}</TableCell>
                    <TableCell>{step.due ?? "—"}</TableCell>
                    <TableCell>
                      {step.evidence?.url === null || step.evidence === null ? (
                        step.evidence?.text || "—"
                      ) : (
                        <Link
                          href={step.evidence.url}
                          target="_blank"
                          rel="noreferrer"
                          underline="hover"
                        >
                          {step.evidence.text || "Open evidence"}
                        </Link>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
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
    version === undefined ? null : "/api/releases"
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
