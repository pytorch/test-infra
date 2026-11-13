import {
  Breadcrumbs,
  Button,
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
import type { ArtifactPage, ReleaseIndex } from "lib/api/releases/types";
import {
  isReleaseNotFound,
  ReleaseResource,
  useReleaseResource,
} from "lib/releasePortal/api";
import Head from "next/head";
import NextLink from "next/link";
import { useRouter } from "next/router";

function routeValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function artifactEndpoint(version: string, cursor: string | undefined): string {
  const path = `/api/releases/${encodeURIComponent(version)}/artifacts`;
  return cursor === undefined
    ? path
    : `${path}?cursor=${encodeURIComponent(cursor)}`;
}

function sizeLabel(size: number | null): string {
  if (size === null) return "—";
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(size);
}

export function ReleaseArtifactsPageContent({
  version,
  artifacts,
  index,
  onPrevious,
  onNext,
}: {
  version: string | undefined;
  artifacts: ReleaseResource<ArtifactPage>;
  index: ReleaseResource<ReleaseIndex>;
  onPrevious: (() => void) | undefined;
  onNext: (() => void) | undefined;
}) {
  if (version === undefined) {
    return <ReleaseLoading title="Release artifacts" rows={2} />;
  }

  if (artifacts.error !== undefined && artifacts.data === undefined) {
    if (isReleaseNotFound(artifacts.error)) {
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
        resource={`artifacts for release ${version}`}
        error={artifacts.error}
        onRetry={artifacts.retry}
      />
    );
  }
  if (artifacts.data === undefined) {
    return <ReleaseLoading title={`Release ${version} artifacts`} rows={4} />;
  }

  const page = artifacts.data;
  return (
    <ReleasePage>
      <Stack spacing={1}>
        <Breadcrumbs>
          <Link component={NextLink} href="/release" underline="hover">
            Releases
          </Link>
          <Link
            component={NextLink}
            href={`/release/${version}`}
            underline="hover"
          >
            {version}
          </Link>
          <Typography color="text.primary">Artifacts</Typography>
        </Breadcrumbs>
        <Typography component="h1" variant="h4" fontWeight={600}>
          Release {version} artifacts
        </Typography>
        <Typography color="text.secondary">
          {page.rc === null
            ? "No release candidate is selected."
            : `Showing observations for ${page.rc}.`}
        </Typography>
      </Stack>

      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Typography fontWeight={600}>
          {page.summary.present}/{page.summary.expected} present ·{" "}
          {page.summary.missing} missing · {page.summary.size_anomalous} size
          anomalies · {page.summary.unexpected} unexpected
        </Typography>
      </Paper>

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Artifact</TableCell>
              <TableCell>Target</TableCell>
              <TableCell>Channel</TableCell>
              <TableCell>Verdict</TableCell>
              <TableCell>Size</TableCell>
              <TableCell>Evidence</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {page.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6}>
                  No artifacts match this selection.
                </TableCell>
              </TableRow>
            ) : (
              page.rows.map((artifact) => (
                <TableRow
                  key={[
                    artifact.channel,
                    artifact.package,
                    artifact.project,
                    artifact.accelerator,
                    artifact.python,
                    artifact.os,
                    artifact.arch,
                  ].join("/")}
                >
                  <TableCell>
                    {artifact.project} · {artifact.package}
                  </TableCell>
                  <TableCell>
                    {artifact.os}/{artifact.arch} · {artifact.accelerator}
                    {artifact.python === "" ? "" : ` · py${artifact.python}`}
                  </TableCell>
                  <TableCell>
                    {artifact.channel}
                    {artifact.rc === null ? "" : ` · ${artifact.rc}`}
                  </TableCell>
                  <TableCell>{artifact.verdict.replaceAll("_", " ")}</TableCell>
                  <TableCell>{sizeLabel(artifact.size_bytes)}</TableCell>
                  <TableCell>
                    {artifact.evidence.url === null ? (
                      artifact.evidence.http_status === null ? (
                        "—"
                      ) : (
                        `HTTP ${artifact.evidence.http_status}`
                      )
                    ) : (
                      <Link
                        href={artifact.evidence.url}
                        target="_blank"
                        rel="noreferrer"
                        underline="hover"
                      >
                        {artifact.evidence.http_status === null
                          ? "Open"
                          : `HTTP ${artifact.evidence.http_status}`}
                      </Link>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <Stack direction="row" justifyContent="space-between">
        <Button disabled={onPrevious === undefined} onClick={onPrevious}>
          Previous
        </Button>
        <Button disabled={onNext === undefined} onClick={onNext}>
          Next
        </Button>
      </Stack>
    </ReleasePage>
  );
}

export default function ReleaseArtifactsPage() {
  const router = useRouter();
  const version = routeValue(router.query.version);
  const cursor = routeValue(router.query.cursor);
  const artifacts = useReleaseResource<ArtifactPage>(
    version === undefined ? null : artifactEndpoint(version, cursor)
  );
  const index = useReleaseResource<ReleaseIndex>(
    version === undefined ? null : "/api/releases"
  );
  const setCursor = (nextCursor: string | null) => {
    if (version === undefined) return;
    void router.push({
      pathname: router.pathname,
      query:
        nextCursor === null ? { version } : { version, cursor: nextCursor },
    });
  };

  return (
    <>
      <Head>
        <title>
          {version === undefined
            ? "Release Artifacts | PyTorch CI HUD"
            : `Release ${version} Artifacts | PyTorch CI HUD`}
        </title>
      </Head>
      <ReleaseArtifactsPageContent
        version={version}
        artifacts={artifacts}
        index={index}
        onPrevious={
          artifacts.data?.pagination.previous === null ||
          artifacts.data === undefined
            ? undefined
            : () =>
                setCursor(artifacts.data?.pagination.previous?.cursor ?? null)
        }
        onNext={
          artifacts.data?.pagination.next === null ||
          artifacts.data === undefined
            ? undefined
            : () => setCursor(artifacts.data?.pagination.next?.cursor ?? null)
        }
      />
    </>
  );
}
