import {
  Breadcrumbs,
  Button,
  Chip,
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
import { ReleaseStatCard } from "components/release/ReleaseComponents";
import {
  ReleaseLoadError,
  ReleaseLoading,
  ReleaseNotFound,
  ReleasePage,
} from "components/release/ReleasePage";
import type {
  ArtifactPage,
  ArtifactRow,
  ReleaseIndex,
} from "lib/api/releases/types";
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
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${new Intl.NumberFormat("en", {
    maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0,
  }).format(value)} ${units[unit]}`;
}

function deltaLabel(delta: number | null): string {
  if (delta === null) return "—";
  const sign = delta > 0 ? "+" : "";
  return `${sign}${new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
  }).format(delta)}%`;
}

const verdictDisplay: Record<ArtifactRow["verdict"], string> = {
  missing: "Missing",
  present: "Present",
  size_anomalous: "Size anomaly",
  unexpected: "Unexpected",
};

const verdictColor: Record<
  ArtifactRow["verdict"],
  "default" | "error" | "success" | "warning"
> = {
  missing: "error",
  present: "success",
  size_anomalous: "warning",
  unexpected: "warning",
};

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

      <Stack spacing={1.5}>
        <Grid container spacing={2}>
          <Grid size={{ xs: 6, md: 3 }}>
            <ReleaseStatCard label="Expected" value={page.summary.expected} />
          </Grid>
          <Grid size={{ xs: 6, md: 3 }}>
            <ReleaseStatCard label="Present" value={page.summary.present} />
          </Grid>
          <Grid size={{ xs: 6, md: 3 }}>
            <ReleaseStatCard
              accent="blocked"
              label="Missing"
              value={page.summary.missing}
            />
          </Grid>
          <Grid size={{ xs: 6, md: 3 }}>
            <ReleaseStatCard
              accent="blocked"
              label="Size-anomalous"
              value={page.summary.size_anomalous}
            />
          </Grid>
        </Grid>
        {page.summary.unexpected > 0 && (
          <Typography color="warning.main" variant="body2">
            {page.summary.unexpected} unexpected artifact
            {page.summary.unexpected === 1 ? "" : "s"} in this selection.
          </Typography>
        )}
      </Stack>

      <TableContainer component={Paper} variant="outlined">
        <Table aria-label={`Artifacts for release ${version}`} size="small">
          <TableHead>
            <TableRow>
              <TableCell>Verdict</TableCell>
              <TableCell>Accelerator</TableCell>
              <TableCell>Python</TableCell>
              <TableCell>OS</TableCell>
              <TableCell>Architecture</TableCell>
              <TableCell>Package</TableCell>
              <TableCell align="right">Size</TableCell>
              <TableCell align="right">Δ%</TableCell>
              <TableCell>Evidence</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {page.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9}>
                  No artifacts match this selection.
                </TableCell>
              </TableRow>
            ) : (
              page.rows.map((artifact) => (
                <TableRow
                  key={[
                    artifact.rc,
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
                    <Chip
                      color={verdictColor[artifact.verdict]}
                      label={verdictDisplay[artifact.verdict]}
                      size="small"
                      variant={
                        artifact.verdict === "present" ? "filled" : "outlined"
                      }
                    />
                  </TableCell>
                  <TableCell>{artifact.accelerator}</TableCell>
                  <TableCell>
                    {artifact.python === "" ? "—" : artifact.python}
                  </TableCell>
                  <TableCell>{artifact.os}</TableCell>
                  <TableCell>{artifact.arch}</TableCell>
                  <TableCell>
                    {artifact.project} · {artifact.package}
                  </TableCell>
                  <TableCell align="right">
                    {sizeLabel(artifact.size_bytes)}
                  </TableCell>
                  <TableCell align="right">
                    {deltaLabel(artifact.vs_previous_pct)}
                  </TableCell>
                  <TableCell>
                    {isSafeReleaseUrl(artifact.evidence.url) ? (
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
                    ) : artifact.evidence.http_status === null ? (
                      "—"
                    ) : (
                      `HTTP ${artifact.evidence.http_status}`
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
    releaseIndexUrlForNotFound(version, artifacts)
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
