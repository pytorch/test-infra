import { Breadcrumbs, Grid, Link, Stack, Typography } from "@mui/material";
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
import { ReleaseStepTable } from "components/release/ReleaseStepTable";
import type {
  ReleaseBoard,
  ReleaseIndex,
  ReleaseMilestoneItems,
} from "lib/api/releases/types";
import {
  isReleaseNotFound,
  releaseIndexUrlForNotFound,
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
  milestone,
}: {
  version: string | undefined;
  board: ReleaseResource<ReleaseBoard>;
  index: ReleaseResource<ReleaseIndex>;
  milestone: ReleaseResource<ReleaseMilestoneItems>;
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

      <ReleaseStepTable
        key={release.version}
        milestone={milestone}
        phases={release.phases}
      />
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
  const milestone = useReleaseResource<ReleaseMilestoneItems>(
    version === undefined || board.data === undefined
      ? null
      : `/api/releases/${encodeURIComponent(version)}/milestone`
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
      <ReleaseBoardPageContent
        version={version}
        board={board}
        index={index}
        milestone={milestone}
      />
    </>
  );
}
