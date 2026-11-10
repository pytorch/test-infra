import { Alert } from "@mui/material";
import LoadError from "components/tests/LoadError";
import PageColumn from "components/tests/PageColumn";
import RunGrid from "components/tests/RunGrid";
import TestHeader from "components/tests/TestHeader";
import { labelOf } from "lib/tests/facets";
import { GridQuery, gridUrlParams, resolveGridQuery } from "lib/tests/grid";
import { mergedUrlQuery } from "lib/tests/url";
import { useTestDetail } from "lib/tests/useTestDetail";
import { useTestGrid } from "lib/tests/useTestGrid";
import { useTestsOptions } from "lib/tests/useTestsOptions";
import { useRouter } from "next/router";
import { useMemo } from "react";

// One test of one repository: its header from GET /api/tests/test/{test_id},
// where it lives, its name and a few facts, and under it the grid of its
// runs from GET /api/tests/test/{test_id}/runs?group_by=commit, one lane per
// workflow configuration and one column per commit. The id in the URL is
// the API's stable test id, the one the list's entries carry. What the grid
// shows travels in the URL's query parameters, left off at the page's
// defaults: the code sources and the window as the API spells them, and the
// page's own, the outcomes shown, the time bar, the commit sought and the
// configuration marked, which the list's evidence links name
// (gridUrlParams), resolved against GET /api/tests/options, which also
// labels the language and the choices, like every label on the list page;
// the choices are keys in the grid's header. The page is public, as the
// list page is: the API's GitHub gate lets its requests through.
export default function Page() {
  const router = useRouter();
  const { organization, repo, test_id: testIdParam } = router.query;
  const repository =
    typeof organization === "string" && typeof repo === "string"
      ? `${organization}/${repo}`
      : undefined;
  const testId = typeof testIdParam === "string" ? testIdParam : undefined;
  const { detail, notFound, error, retry } = useTestDetail(testId);
  const {
    options,
    error: optionsError,
    retry: retryOptions,
  } = useTestsOptions();
  const gridQuery = useMemo(
    () =>
      options === undefined
        ? undefined
        : resolveGridQuery(router.query, options),
    [router.query, options]
  );
  // The URL names a repository and the page shows only that repository's
  // test: a test of another repository is as good as none.
  const test =
    detail !== undefined && detail.test.repo === repository
      ? detail.test
      : undefined;
  const missing = notFound || (detail !== undefined && test === undefined);
  // The grid is asked for as soon as the choices are known, alongside the
  // test, and shown once the test is known to be this repository's.
  const runs = useTestGrid(missing ? undefined : testId, gridQuery);
  // The language as the options label it; the value itself should the
  // options fail, since a word is better than a gap.
  const languageLabel =
    test === undefined
      ? undefined
      : options !== undefined
      ? labelOf(test.language, options.language.values)
      : optionsError !== undefined
      ? test.language
      : undefined;

  // A choice in the grid's header: into the URL, in place of the current
  // entry, with every other parameter kept and the defaults left off.
  const handleGridQueryChange = (next: GridQuery) => {
    void router.replace(
      {
        pathname: router.pathname,
        query: mergedUrlQuery(router.query, gridUrlParams(next)),
      },
      undefined,
      { shallow: true }
    );
  };

  return (
    <PageColumn>
      <TestHeader
        test={test}
        owners={test === undefined ? [] : detail?.owners ?? []}
        languageLabel={languageLabel}
        loading={!missing && error === undefined}
      />
      {missing && (
        <Alert severity="warning">
          No test in {repository} has the id {testId}.
        </Alert>
      )}
      {error !== undefined && (
        <LoadError what="the test" error={error} onRetry={retry} />
      )}
      {optionsError !== undefined && (
        <LoadError
          what="the choices"
          error={optionsError}
          onRetry={retryOptions}
        />
      )}
      {!missing && error === undefined && (
        <RunGrid
          grid={runs.grid}
          loading={runs.loading}
          timing={runs.timing}
          error={runs.error}
          onRetry={runs.retry}
          options={options}
          query={gridQuery}
          onQueryChange={handleGridQueryChange}
        />
      )}
    </PageColumn>
  );
}
