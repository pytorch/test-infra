import {
  Alert,
  Breadcrumbs,
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
import { alpha, type Theme } from "@mui/material/styles";
import {
  ReleaseRcChip,
  ReleaseStatCard,
} from "components/release/ReleaseComponents";
import {
  ReleaseLoadError,
  ReleaseLoading,
  ReleaseNotFound,
  ReleasePage,
} from "components/release/ReleasePage";
import type {
  CrcrRepo,
  ReleaseCrcr,
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
import { Fragment, ReactNode } from "react";

// The allowlist the CRCR relay reads, in pytorch/pytorch (pages/api/crcr/allowlist.ts).
const ALLOWLIST_URL =
  "https://github.com/pytorch/pytorch/blob/main/.github/allowlist.yml";

const RESULT_DISPLAY: Record<
  CrcrRepo["result"],
  { label: string; color: "error" | "success" | "warning"; filled: boolean }
> = {
  failed: { label: "Failed", color: "error", filled: true },
  no_result: { label: "No result", color: "warning", filled: false },
  passed: { label: "Passed", color: "success", filled: true },
};

function routeVersion(
  value: string | string[] | undefined
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finishedLabel(finishedAt: string): string {
  const date = new Date(finishedAt);
  if (Number.isNaN(date.getTime())) {
    return "Not reported";
  }
  return `${new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date)} UTC`;
}

// A link when the API gave a safe URL, the bare text otherwise.
function SafeLink({
  url,
  children,
}: {
  url: string | null;
  children: ReactNode;
}) {
  return isSafeReleaseUrl(url) ? (
    <Link href={url} rel="noreferrer" target="_blank" underline="hover">
      {children}
    </Link>
  ) : (
    <span>{children}</span>
  );
}

function EvidenceCell({ repo }: { repo: CrcrRepo }) {
  if (repo.run_url === null && repo.hud_url === null) {
    return (
      <Typography color="text.secondary" variant="body2">
        {repo.result === "no_result" ? "—" : "Run unavailable"}
      </Typography>
    );
  }
  return (
    <Stack spacing={0.5}>
      {repo.run_url !== null && (
        <SafeLink url={repo.run_url}>CRCR run</SafeLink>
      )}
      {repo.hud_url !== null && (
        <SafeLink url={repo.hud_url}>Repo on HUD</SafeLink>
      )}
    </Stack>
  );
}

function RepoRows({ repo }: { repo: CrcrRepo }) {
  const display = RESULT_DISPLAY[repo.result];
  const failed = repo.result === "failed";
  // The palette's own error colour, so it reads in the light and the dark theme.
  const tint = (theme: Theme) =>
    failed ? alpha(theme.palette.error.main, 0.06) : undefined;

  return (
    <Fragment>
      <TableRow
        sx={{
          bgcolor: tint,
          // The failing jobs row below belongs to this one.
          "& > td": { borderBottom: failed ? 0 : undefined },
        }}
      >
        <TableCell>
          <Link
            href={`https://github.com/${repo.repo}`}
            rel="noreferrer"
            target="_blank"
            underline="hover"
          >
            {repo.repo}
          </Link>
        </TableCell>
        <TableCell>
          <Chip
            color="info"
            label={repo.level}
            size="small"
            variant="outlined"
          />
        </TableCell>
        <TableCell>
          <ReleaseRcChip rc={repo.rc} />
        </TableCell>
        <TableCell>
          <Chip
            color={display.color}
            label={display.label}
            size="small"
            variant={display.filled ? "filled" : "outlined"}
          />
        </TableCell>
        <TableCell>
          <Typography variant="body2">{repo.summary}</Typography>
          {repo.result !== "passed" && repo.owner !== null && (
            <Typography color="text.secondary" variant="caption">
              Owner: {repo.owner}
            </Typography>
          )}
        </TableCell>
        <TableCell>
          <EvidenceCell repo={repo} />
        </TableCell>
        <TableCell>
          {repo.finished_at === null ? (
            <Typography color="text.secondary" variant="body2">
              {repo.result === "no_result" ? "—" : "Not reported"}
            </Typography>
          ) : (
            <time dateTime={repo.finished_at}>
              {finishedLabel(repo.finished_at)}
            </time>
          )}
        </TableCell>
      </TableRow>
      {failed && (
        <TableRow sx={{ bgcolor: tint }}>
          <TableCell colSpan={7}>
            <Stack
              alignItems="baseline"
              direction="row"
              flexWrap="wrap"
              gap={2}
            >
              <Typography component="span" fontWeight={600} variant="body2">
                Failing jobs:
              </Typography>
              {repo.failing_jobs.length === 0 ? (
                <Typography color="text.secondary" variant="body2">
                  Job details not reported
                </Typography>
              ) : (
                repo.failing_jobs.map((job, position) => (
                  <SafeLink key={`${job.name}-${position}`} url={job.url}>
                    {job.name}
                  </SafeLink>
                ))
              )}
            </Stack>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

function CrcrResults({
  version,
  crcr,
}: {
  version: string;
  crcr: ReleaseCrcr;
}) {
  if (crcr.rc === null) {
    return (
      <Alert severity="info">
        No release candidate has been recorded for downstream validation yet.
      </Alert>
    );
  }
  if (crcr.repos.length === 0) {
    return (
      <Alert severity="info">
        No downstream repos are listed for {crcr.rc.toUpperCase()} yet.
      </Alert>
    );
  }
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table
        aria-label={`Downstream validation for release ${version}`}
        size="small"
      >
        <TableHead>
          <TableRow>
            <TableCell>Repo</TableCell>
            <TableCell>Level</TableCell>
            <TableCell>RC</TableCell>
            <TableCell>Result</TableCell>
            <TableCell>Summary</TableCell>
            <TableCell>Evidence</TableCell>
            <TableCell>Last run</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {crcr.repos.map((repo) => (
            <RepoRows key={repo.repo} repo={repo} />
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export function ReleaseCrcrPageContent({
  version,
  crcr,
  index,
}: {
  version: string | undefined;
  crcr: ReleaseResource<ReleaseCrcr>;
  index: ReleaseResource<ReleaseIndex>;
}) {
  if (version === undefined) {
    return <ReleaseLoading title="Downstream validation" rows={2} />;
  }

  if (crcr.error !== undefined && crcr.data === undefined) {
    if (isReleaseNotFound(crcr.error)) {
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
        resource={`downstream validation for release ${version}`}
        error={crcr.error}
        onRetry={crcr.retry}
      />
    );
  }
  if (crcr.data === undefined) {
    return (
      <ReleaseLoading
        title={`PyTorch ${version} : Downstream validation`}
        rows={4}
      />
    );
  }

  const results = crcr.data;
  return (
    <ReleasePage>
      <Stack spacing={1}>
        <Breadcrumbs>
          <Link component={NextLink} href="/release" underline="hover">
            Releases
          </Link>
          <Link
            component={NextLink}
            href={`/release/${encodeURIComponent(version)}`}
            underline="hover"
          >
            {version}
          </Link>
          <Typography color="text.primary">Downstream validation</Typography>
        </Breadcrumbs>
        <Typography component="h1" variant="h4" fontWeight={600}>
          PyTorch {version} : Downstream validation
        </Typography>
        <Typography color="text.secondary">
          {results.rc === null
            ? "No release candidate has been recorded yet."
            : `Results against ${results.rc.toUpperCase()}, the current release candidate.`}{" "}
          CI of the downstream repos in the CRCR allowlist (L2 and above) that
          opted in to release validation; problems first.
        </Typography>
        <Stack direction="row" flexWrap="wrap" gap={2}>
          <Link component={NextLink} href="/crcr" underline="hover">
            CRCR dashboard
          </Link>
          <Link
            href={ALLOWLIST_URL}
            rel="noreferrer"
            target="_blank"
            underline="hover"
          >
            Allowlist
          </Link>
        </Stack>
      </Stack>

      <Grid container spacing={2}>
        <Grid size={{ xs: 6, md: 3 }}>
          <ReleaseStatCard
            label="Downstream repos"
            value={results.summary.repos}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <ReleaseStatCard label="Passing" value={results.summary.passing} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <ReleaseStatCard
            accent={results.summary.failing > 0 ? "blocked" : "default"}
            label="Failing"
            value={results.summary.failing}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <ReleaseStatCard
            label="No result"
            value={results.summary.no_result}
          />
        </Grid>
      </Grid>

      <Alert severity="info">
        <strong>Informational.</strong> A downstream failure does not block the
        release. Each downstream repo owns its failures (RFC-0050); the release
        manager makes the go or no-go call.
      </Alert>

      <CrcrResults version={version} crcr={results} />
    </ReleasePage>
  );
}

export default function ReleaseCrcrPage() {
  const router = useRouter();
  const version = routeVersion(router.query.version);
  const crcr = useReleaseResource<ReleaseCrcr>(
    version === undefined
      ? null
      : `/api/releases/${encodeURIComponent(version)}/crcr`
  );
  const index = useReleaseResource<ReleaseIndex>(
    releaseIndexUrlForNotFound(version, crcr)
  );

  return (
    <>
      <Head>
        <title>
          {version === undefined
            ? "Release Downstream Validation | PyTorch CI HUD"
            : `Release ${version} Downstream Validation | PyTorch CI HUD`}
        </title>
      </Head>
      <ReleaseCrcrPageContent version={version} crcr={crcr} index={index} />
    </>
  );
}
