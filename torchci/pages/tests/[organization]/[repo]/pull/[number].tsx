import { Alert, Stack, Typography } from "@mui/material";
import CommitHeader from "components/tests/CommitHeader";
import LoadError from "components/tests/LoadError";
import PageColumn from "components/tests/PageColumn";
import { HEADLINE_SX } from "lib/tests/header";
import { pullPageTarget } from "lib/tests/pullPage";
import { usePullRequestHead } from "lib/tests/usePullRequestHead";
import { useRouter } from "next/router";
import { useEffect, useRef } from "react";
import { SWRConfig } from "swr";

// A pull request of one repository, as a way to its newest commit: the page
// asks GET /api/tests/pull/{number} for the pull request's newest head and
// opens that commit's page in its place (router.replace, so going back
// skips it), passing on the commit page's parameters its URL carries
// (pullPageTarget in lib/tests/pullPage.ts). Until then it holds the commit
// page's own loading header, so the commit page arrives without a jump. The
// page is public, as the other hub pages are: the API's GitHub gate lets its
// requests through. A number HUD has no pull request for is said in place of
// the commit; any other failure shows the API's error with a Retry.

// Each visit asks the API afresh, in an SWR cache of its own. From the
// shared cache, a later visit in the same tab would get the head an earlier
// visit found and open it at once, since SWR shows a cached answer first
// and asks again only on the next animation frame, though the pull request
// may have moved on since.
const VISIT_CACHE = { provider: () => new Map() };

export default function Page() {
  return (
    <SWRConfig value={VISIT_CACHE}>
      <PullRequestPage />
    </SWRConfig>
  );
}

function PullRequestPage() {
  const router = useRouter();
  const { organization, repo, number } = router.query;
  const repository =
    typeof organization === "string" && typeof repo === "string"
      ? `${organization}/${repo}`
      : undefined;
  const pullNumber = typeof number === "string" ? number : undefined;
  const { pullRequest, notFound, error, retry } = usePullRequestHead(
    repository,
    pullNumber
  );

  // The head's commit page, opened once the head is known. The router is
  // read when the page is opened, so a router that changes meanwhile does
  // not open it twice.
  const latestRouter = useRef(router);
  latestRouter.current = router;
  const headSha = pullRequest?.head_sha;
  useEffect(() => {
    if (repository === undefined || headSha === undefined) return;
    const current = latestRouter.current;
    void current.replace(pullPageTarget(repository, headSha, current.query));
  }, [repository, headSha]);

  if (!notFound && error === undefined) {
    return (
      <PageColumn>
        <CommitHeader repo={repository ?? ""} commit={undefined} loading />
      </PageColumn>
    );
  }
  return (
    <PageColumn>
      <Stack spacing={2.5}>
        <Typography component="h1" sx={HEADLINE_SX}>
          {pullNumber === undefined
            ? "Pull request"
            : `Pull request #${pullNumber}`}
        </Typography>
        {notFound ? (
          <Alert severity="warning">
            HUD has no pull request #{pullNumber} in {repository}.
          </Alert>
        ) : (
          <LoadError what="the pull request" error={error} onRetry={retry} />
        )}
      </Stack>
    </PageColumn>
  );
}
