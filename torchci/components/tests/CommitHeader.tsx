import { Box, Link, Typography } from "@mui/material";
import FactPill from "components/tests/FactPill";
import {
  FactsRow,
  HeaderCrumbs,
  HeaderRule,
  HeaderSkeleton,
} from "components/tests/PageHeader";
import type { CommitRecord } from "lib/api/tests/commit/summary/types";
import { commitPagePath } from "lib/api/tests/pages/parameters";
import {
  commitCrumbs,
  commitPullRequestNumber,
  headline,
  pullRequestUrl,
  shortSha,
  whenExact,
  whenLabel,
} from "lib/tests/commit";
import {
  HEADLINE_SX,
  MONOSPACE_FONT_FAMILY,
  UNKNOWN_VALUE,
} from "lib/tests/header";
import { useMounted } from "lib/tests/useMounted";
import NextLink from "next/link";
import { Fragment, ReactNode } from "react";

export interface CommitHeaderProps {
  // The repository as owner/name.
  repo: string;
  // The commit shown; undefined while there is none to show.
  commit: CommitRecord | undefined;
  // With no commit: whether one is on its way, so the header holds its
  // place, or there is none, so it says only what the page is.
  loading?: boolean;
}

// When the commit was made, filled in on the client only: the server does
// not know the viewer's time zone.
function Committed({ timestamp }: { timestamp: string }) {
  const mounted = useMounted();
  if (!mounted) return <span />;
  return <span title={whenExact(timestamp)}>{whenLabel(timestamp)}</span>;
}

// A muted link in the headline or a pill: the pull request a title names,
// a neighbouring commit.
function MutedLink({
  href,
  title,
  children,
}: {
  href: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Link
      component={NextLink}
      href={href}
      prefetch={false}
      title={title}
      underline="hover"
      sx={{ color: "text.secondary", fontWeight: 400 }}
    >
      {children}
    </Link>
  );
}

// The commit's title as the headline (headline in lib/tests/commit.ts): its
// text, the spans the author set in backticks as code, and any "#N" in it
// as a muted link to that pull request. The "(#N)" a merged commit's title
// ends in is taken off; that pull request is the first pill of the facts
// row.
function Title({ repo, commit }: { repo: string; commit: CommitRecord }) {
  const { pieces } = headline(commit.title);
  return (
    <Typography component="h1" sx={HEADLINE_SX}>
      {pieces.map((piece, index) => (
        <Fragment key={index}>
          {piece.kind === "text" ? (
            piece.text
          ) : piece.kind === "code" ? (
            <Box
              component="code"
              sx={{ fontFamily: MONOSPACE_FONT_FAMILY, fontSize: "0.9em" }}
            >
              {piece.text}
            </Box>
          ) : (
            <MutedLink href={pullRequestUrl(repo, piece.number, commit)}>
              {piece.text}
            </MutedLink>
          )}
        </Fragment>
      ))}
    </Typography>
  );
}

// The two neighbours of a commit on its branch, the nearest with test jobs
// either way, in the order of time: the older to the left, the newer to the
// right, each named by its short SHA and linking its page; a side with no
// neighbour is muted.
function Neighbours({ repo, commit }: { repo: string; commit: CommitRecord }) {
  const side = (sha: string | null, before: string, after: string) =>
    sha === null ? (
      <Box component="span" sx={{ color: "text.disabled" }}>
        {`${before}${after}`.trim()}
      </Box>
    ) : (
      <MutedLink href={commitPagePath(repo, sha)} title={sha}>
        {before}
        <Box
          component="span"
          sx={{ fontFamily: MONOSPACE_FONT_FAMILY, fontSize: "0.9em" }}
        >
          {shortSha(sha)}
        </Box>
        {after}
      </MutedLink>
    );
  return (
    <Box component="span" sx={{ display: "inline-flex", gap: 1 }}>
      {side(commit.older_sha, "‹ Older ", "")}
      <Box component="span" sx={{ color: "text.disabled" }}>
        /
      </Box>
      {side(commit.newer_sha, "Newer ", " ›")}
    </Box>
  );
}

// The header of a commit's page, set from the hub's header pieces
// (PageHeader): where the commit lives, as a monospace breadcrumb; its
// title, the headline; and a row of facts as pills, first the pull request's
// number linking it when the commit has one, the commit's short SHA linking
// its page on GitHub, then the author, when it was committed, and on a
// branch its neighbours, older to the left and newer to the right, the
// branch itself being in the breadcrumb, or for a pull request head its
// branch. Until the commit arrives a skeleton holds each line's place; with
// no commit to show the headline says "Commit" and the rest is left out.
export default function CommitHeader({
  repo,
  commit,
  loading = false,
}: CommitHeaderProps) {
  if (commit === undefined) {
    if (!loading) {
      return (
        <Typography component="h1" sx={HEADLINE_SX}>
          Commit
        </Typography>
      );
    }
    return <HeaderSkeleton pillWidths={["18ch", "22ch", "16ch"]} />;
  }
  const author = commit.author.name ?? commit.author.login;
  const pullRequestNumber = commitPullRequestNumber(commit);
  return (
    <Box>
      <HeaderCrumbs crumbs={commitCrumbs(repo, commit)} />
      <Title repo={repo} commit={commit} />
      <FactsRow>
        {pullRequestNumber !== null && (
          <FactPill
            tone="accent"
            label="PR"
            href={pullRequestUrl(repo, pullRequestNumber, commit)}
          >
            {`#${pullRequestNumber}`}
          </FactPill>
        )}
        <FactPill label="Commit" href={commit.url} title={commit.sha}>
          <Box
            component="span"
            sx={{ fontFamily: MONOSPACE_FONT_FAMILY, fontSize: "0.9em" }}
          >
            {shortSha(commit.sha)}
          </Box>
        </FactPill>
        <FactPill label="Author" muted={author === null}>
          {author === null ? (
            UNKNOWN_VALUE
          ) : (
            <span title={commit.author.login ?? undefined}>{author}</span>
          )}
        </FactPill>
        <FactPill label="Committed">
          <Committed timestamp={commit.committed_at} />
        </FactPill>
        {commit.pull_request_head || commit.branch === null ? (
          <FactPill label="Branch" muted={commit.branch === null}>
            {commit.branch ?? UNKNOWN_VALUE}
          </FactPill>
        ) : (
          <FactPill>
            <Neighbours repo={repo} commit={commit} />
          </FactPill>
        )}
      </FactsRow>
      <HeaderRule />
    </Box>
  );
}
