import type { CommitJobsField } from "lib/api/tests/commit/jobs/parameters";
import type { CommitSummary } from "lib/api/tests/commit/summary/types";
import { JobIdSchema } from "lib/api/tests/job/parameters";
import type { JobDetail } from "lib/api/tests/job/types";
import {
  COMMIT_PAGE_DEFAULT_SORT,
  COMMIT_PAGE_DEFAULT_STATUSES,
  COMMIT_PAGE_FILTER_NAMES,
  COMMIT_PAGE_PARAMETER_DEFINITIONS,
  CommitPageFilterName,
  decodePageQuery,
  pageUrlParams,
} from "lib/api/tests/pages/parameters";
import type { RunRecord } from "lib/api/tests/test/runs/types";
import { BUNDLE_STATUSES, BundleStatus } from "lib/runOutcomes";
import { AttemptGroup, attemptGroups, bundleStatus } from "lib/tests/bundle";
import {
  SHARED_COLUMN_DESCRIPTIONS,
  SHARED_COLUMN_SORT_FIELDS,
} from "lib/tests/columns";
import { STATUS_TITLES } from "lib/tests/commit";
import {
  FacetValues,
  noFacetValues,
  phraseList,
  TestsFacet,
} from "lib/tests/facets";
import {
  commitCounts,
  LISTED_TESTS,
  noCounts,
  nodeOfPick,
  StatusCounts,
  Timeline,
  TimelinePick,
} from "lib/tests/timeline";
import type { UrlQuery } from "lib/tests/url";

// The commit page's glue between its URL, its state and the API, free of
// React: which outcomes are listed, the filters and the search, the sort,
// and the URLs of GET /api/tests/commit/{sha}/summary and
// GET /api/tests/commit/{sha} that answer them. The parameters are the
// page's definitions in lib/api/tests/pages/parameters.ts, so each is
// spelled as the API spells it and the OpenAPI document lists the page with
// them.

// The list comes a page of the API's largest size at a time.
export const PAGE_SIZE = 100;
// The page asks for the pages after the first one after another, under the
// table's progress bar, while the list has not reached a common status
// (autoLoads) and holds fewer than this many rows; past that a "Show more"
// row asks for the next page, so a commit that broke trunk does not fetch
// its thousands of failures at once: each page is a read of the commit's
// runs, and the rows render unvirtualized. Three pages hold a healthy main
// commit's problem runs whole (about a hundred on 2026-10-30's ce6ff46).
export const AUTO_LIMIT = 3 * PAGE_SIZE;

// Passes, expected failures and skips: most of a commit's runs, off by
// default (COMMIT_PAGE_DEFAULT_STATUSES lists the others), and when listed
// loaded a page at a time on request. In the outcome order `other`, listed
// by default, follows passed, so with passed listed the loading stops at the
// passed rows and resumes should a page end on an other row.
export const COMMON_STATUSES: readonly BundleStatus[] = BUNDLE_STATUSES.filter(
  (status) => !COMMIT_PAGE_DEFAULT_STATUSES.includes(status)
);

// Each sortable column of the table and the API sort fields, in order, that
// sorting by it means: the shared columns' from lib/tests/columns.ts, then
// the page's own. The outcome comes first in every order; the page adds it.
export const COMMIT_TABLE_SORT_FIELDS: Record<string, readonly string[]> = {
  name: SHARED_COLUMN_SORT_FIELDS.name,
  duration: ["duration_milliseconds"],
  environment: SHARED_COLUMN_SORT_FIELDS.environment,
  test_config: SHARED_COLUMN_SORT_FIELDS.test_config,
  job: ["job_name"],
  owners: SHARED_COLUMN_SORT_FIELDS.owners,
};
export const DEFAULT_COMMIT_SORT = COMMIT_PAGE_DEFAULT_SORT.join(",");

// The facets the page's column filters hold: every one of the list's but
// the health status, whose place the Outcome filter takes.
export const COMMIT_FACETS = COMMIT_PAGE_FILTER_NAMES.filter(
  (name): name is Exclude<CommitPageFilterName, "search"> => name !== "search"
);

// What the page shows, as its URL says it.
export interface CommitPageState {
  // Text the names are searched for; empty for none.
  search: string;
  // The column filters, each empty for no filter; status is never set.
  filters: FacetValues;
  // The outcomes listed, in BUNDLE_STATUSES order.
  statuses: BundleStatus[];
  // The API sort parameter, without the outcome the page puts first.
  sort: string;
  // What is picked in the timeline, whose tests the table lists; null for
  // nothing, the whole commit.
  pick: TimelinePick | null;
}

// The outcomes listed until the URL says otherwise: the page's defaults for
// the whole commit, and every outcome of a pick, failures first.
export function usualStatuses(pick: TimelinePick | null): BundleStatus[] {
  return BUNDLE_STATUSES.filter(
    (status) => pick !== null || COMMIT_PAGE_DEFAULT_STATUSES.includes(status)
  );
}

// The pick the URL's parameters name: a job, with a file of it and a test
// of that file; else a workflow, with its run and attempt and a build of it.
function pickFromUrl(
  values: Partial<Record<string, string | string[]>>
): TimelinePick | null {
  const text = (name: string) => {
    const value = values[name];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const jobId = JobIdSchema.safeParse(text("job_id"));
  const file = text("file");
  const caseName = text("case_name");
  const workflow = text("workflow");
  const build = text("build");
  if (jobId.success) {
    if (file === undefined) return { kind: "job", jobId: jobId.data };
    return caseName === undefined
      ? { kind: "file", jobId: jobId.data, file }
      : {
          kind: "test",
          jobId: jobId.data,
          file,
          suite: text("suite") ?? "",
          caseName,
        };
  }
  if (workflow === undefined) return null;
  const { run_id, run_attempt } = COMMIT_PAGE_PARAMETER_DEFINITIONS;
  const runId = run_id.schema.safeParse(text("run_id")).data;
  const attempt = run_attempt.schema.safeParse(text("run_attempt")).data;
  const row = {
    workflow,
    ...(runId !== undefined && { runId }),
    ...(attempt !== undefined && { attempt }),
  };
  return build === undefined
    ? { kind: "workflow", ...row }
    : { kind: "build", ...row, build };
}

// Reads the page's URL: each parameter by its definition, a value its
// schema refuses falling back to the default rather than failing.
export function commitPageStateFromUrl(url: UrlQuery): CommitPageState {
  const values = decodePageQuery(url, COMMIT_PAGE_PARAMETER_DEFINITIONS);
  const definitions = COMMIT_PAGE_PARAMETER_DEFINITIONS;
  const statuses = definitions.status.schema.safeParse(values.status);
  const sort = definitions.sort.schema.safeParse(values.sort);
  const filters = noFacetValues();
  for (const facet of COMMIT_FACETS) {
    const given = values[facet];
    filters[facet as TestsFacet] = given === undefined ? [] : [...given];
  }
  const pick = pickFromUrl(values);
  return {
    search: values.search ?? "",
    filters,
    statuses:
      values.status !== undefined && statuses.success
        ? [...BUNDLE_STATUSES].filter((status) =>
            statuses.data.includes(status)
          )
        : usualStatuses(pick),
    sort: (sort.success ? sort.data : [...COMMIT_PAGE_DEFAULT_SORT]).join(","),
    pick,
  };
}

// The URL parameters for a state, the defaults left off.
export function commitUrlParams(state: CommitPageState): UrlQuery {
  const { pick } = state;
  const row =
    pick?.kind === "workflow" || pick?.kind === "build" ? pick : undefined;
  const values: Record<string, string | string[] | undefined> = {
    search: state.search === "" ? undefined : state.search,
    sort: state.sort.split(","),
    workflow: row?.workflow,
    run_id: row?.runId,
    run_attempt: row?.attempt?.toString(),
    build: pick?.kind === "build" ? pick.build : undefined,
    job_id:
      pick?.kind === "job" || pick?.kind === "file" || pick?.kind === "test"
        ? pick.jobId
        : undefined,
    file:
      pick?.kind === "file" || pick?.kind === "test" ? pick.file : undefined,
    suite: pick?.kind === "test" ? pick.suite : undefined,
    case_name: pick?.kind === "test" ? pick.caseName : undefined,
  };
  for (const facet of COMMIT_FACETS) {
    values[facet] = state.filters[facet as TestsFacet];
  }
  const usual = usualStatuses(pick);
  return {
    ...pageUrlParams(values, COMMIT_PAGE_PARAMETER_DEFINITIONS),
    // Left off while they are the usual ones for what is picked.
    status:
      state.statuses.length === usual.length &&
      state.statuses.every((status) => usual.includes(status))
        ? undefined
        : state.statuses,
  };
}

// Whether two states are one view: the URL would say the same of both.
export function sameView(left: CommitPageState, right: CommitPageState) {
  return (
    JSON.stringify(commitUrlParams(left)) ===
    JSON.stringify(commitUrlParams(right))
  );
}

// Where the API answers for a commit. Of the summary the page asks for what
// its header shows, the commit and the retention's start: the counts, which
// read every run of the commit, are the timeline's here.
export const COMMIT_HEADER_FIELDS = ["commit", "retention_starts_at"] as const;
export type CommitHeaderSummary = Required<
  Pick<CommitSummary, (typeof COMMIT_HEADER_FIELDS)[number]>
>;

export function commitSummaryApiUrl(repo: string, sha: string): string {
  return `/api/tests/commit/${encodeURIComponent(
    sha
  )}/summary?repo=${encodeURIComponent(repo)}${COMMIT_HEADER_FIELDS.map(
    (field) => `&fields=${field}`
  ).join("")}`;
}

export function commitGreenlightApiUrl(repo: string, sha: string): string {
  return `/api/tests/commit/${encodeURIComponent(
    sha
  )}/greenlight?repo=${encodeURIComponent(repo)}`;
}

// One field of the commit's jobs endpoint: the jobs, or what their tests
// did. The page asks for the two apart, at once, and draws the jobs while
// the tests are read.
export function commitJobsApiUrl(
  repo: string,
  sha: string,
  field: CommitJobsField
): string {
  return `/api/tests/commit/${encodeURIComponent(
    sha
  )}/jobs?repo=${encodeURIComponent(repo)}&fields=${field}`;
}

export function jobApiUrl(jobId: string): string {
  return `/api/tests/job/${encodeURIComponent(jobId)}`;
}

// The tests a file of a job names in the timeline: the failed and flaky
// first, then the slowest.
export function fileTestsApiUrl(
  repo: string,
  sha: string,
  jobId: string,
  file: string
): string {
  const search = new URLSearchParams({ repo, job_id: jobId, file });
  search.set("sort", "-status,-duration_milliseconds");
  search.set("limit", String(LISTED_TESTS));
  return `/api/tests/commit/${encodeURIComponent(sha)}?${search.toString()}`;
}

// How the commit's runs endpoint narrows to a pick: a job by its ID, with
// the file and the test's name for those; a workflow by its path, or with
// its jobs' IDs when given, as a build always is.
export interface PickFilter {
  jobIds?: readonly string[];
  workflowPath?: string;
  file?: string;
  suite?: string;
  caseName?: string;
}

// The filter for a pick. A job, a file and a test name their job; a build
// is its jobs, and a workflow its path, or its row's jobs where it has
// several rows, which the commit's jobs say: "waiting" while those are on
// their way, "nothing" for a pick the commit does not have.
export function pickFilterOf(
  pick: TimelinePick | null,
  timeline: Timeline | undefined
): PickFilter | "waiting" | "nothing" {
  if (pick === null) return {};
  if (pick.kind === "job") return { jobIds: [pick.jobId] };
  if (pick.kind === "file") return { jobIds: [pick.jobId], file: pick.file };
  if (pick.kind === "test") {
    return {
      jobIds: [pick.jobId],
      file: pick.file,
      suite: pick.suite,
      caseName: pick.caseName,
    };
  }
  if (timeline === undefined) return "waiting";
  const node = nodeOfPick(timeline, pick);
  const jobs = node?.jobs ?? [];
  if (node === null || jobs.length === 0) return "nothing";
  const { path } = jobs[0].job.workflow;
  const onlyRow = node.runId === undefined && node.attempt === undefined;
  return pick.kind === "workflow" && path !== null && onlyRow
    ? { workflowPath: path }
    : { jobIds: jobs.map(({ job }) => job.id) };
}

// Whether nothing can match: a workflow is picked that the Test Config
// header's workflow filter leaves out.
export function pickFilteredOut(
  filters: FacetValues,
  pick: PickFilter
): boolean {
  const workflows = filters.workflow_path ?? [];
  return (
    pick.workflowPath !== undefined &&
    workflows.length > 0 &&
    !workflows.includes(pick.workflowPath)
  );
}

// Where the table's first page comes from for a view; null while the jobs
// that say what a workflow or a build holds are on their way, and for a
// view that can list nothing.
export function listedRunsApiUrl(
  repo: string,
  sha: string,
  state: CommitPageState,
  timeline: Timeline | undefined
): string | null {
  const filter = pickFilterOf(state.pick, timeline);
  return typeof filter !== "object" || pickFilteredOut(state.filters, filter)
    ? null
    : commitRunsApiUrl(repo, sha, state, PAGE_SIZE, filter);
}

// A page of the commit's runs with the outcomes listed, narrowed by the
// pick, the page's filters and search, in outcome order and within it the
// page's sort: the API's status sort, worst first, then the page's.
export function commitRunsApiUrl(
  repo: string,
  sha: string,
  state: Pick<CommitPageState, "search" | "filters" | "sort" | "statuses">,
  limit: number,
  pick: PickFilter = {}
): string {
  const search = new URLSearchParams();
  search.set("repo", repo);
  for (const status of state.statuses) search.append("status", status);
  if (state.search !== "") search.set("search", state.search);
  for (const facet of COMMIT_FACETS) {
    const values =
      facet === "workflow_path" && pick.workflowPath !== undefined
        ? [pick.workflowPath]
        : state.filters[facet as TestsFacet] ?? [];
    for (const value of values) search.append(facet, value);
  }
  for (const jobId of pick.jobIds ?? []) search.append("job_id", jobId);
  if (pick.file !== undefined) search.set("file", pick.file);
  if (pick.caseName !== undefined) {
    search.set("suite", pick.suite ?? "");
    search.set("case_name", pick.caseName);
  }
  search.set("sort", `-status,${state.sort}`);
  search.set("limit", String(limit));
  return `/api/tests/commit/${encodeURIComponent(sha)}?${search.toString()}`;
}

// The status of a run's bundle, from its attempts' outcomes.
export function runStatus(run: RunRecord): BundleStatus {
  return bundleStatus(run.attempts.map((attempt) => attempt.outcome));
}

// What the table's title sums up: the tests of what is picked by status, a
// test run in several jobs once per job, from what the page has read for
// it: the timeline's for the whole commit, a workflow, a build or a job,
// the job's files for a file, and a test's own runs; undefined while what
// it needs is on its way, the jobs' tests for the timeline's.
export function testCountsOf(read: {
  pick: TimelinePick | null;
  timeline: Timeline | undefined;
  job: JobDetail | undefined;
  runs: readonly RunRecord[] | undefined;
}): StatusCounts | undefined {
  const { pick } = read;
  const counts = noCounts();
  if (pick?.kind === "test") {
    if (read.runs === undefined) return undefined;
    for (const run of read.runs) counts[runStatus(run)] += 1;
    return counts;
  }
  if (pick?.kind === "file") {
    if (read.job === undefined) return undefined;
    const file = read.job.files.find(
      (candidate) => (candidate.file ?? "") === pick.file
    );
    return file?.tests_by_status ?? counts;
  }
  if (read.timeline === undefined || read.timeline.testsPending) {
    return undefined;
  }
  if (pick === null) return commitCounts(read.timeline);
  return nodeOfPick(read.timeline, pick)?.totals.counts ?? counts;
}

// Whether the page asks for the next page by itself: while one follows, the
// list holds fewer than AUTO_LIMIT rows, and its last row is not of a common
// status, which are loaded on request.
export function autoLoads(
  runs: readonly RunRecord[],
  hasMore: boolean
): boolean {
  if (!hasMore || runs.length >= AUTO_LIMIT) return false;
  const last = runs[runs.length - 1];
  return last === undefined || !COMMON_STATUSES.includes(runStatus(last));
}

// The header tooltips, one plain sentence each: the shared columns' and the
// page's own.
export const COMMIT_COLUMN_DESCRIPTIONS = {
  ...SHARED_COLUMN_DESCRIPTIONS,
  name: "The name of the test. A name can appear more than once, in a different environment, test config or job each time.",
  outcome:
    "How the run ended on this commit, with what its attempts did; the filter chooses which outcomes are listed.",
  duration:
    "How long the run took: every attempt that executed, skipped attempts left out.",
  job: "The GitHub job that ran the test, with its shard and runner; the filter picks one job, in the timeline too.",
};

// ---------------------------------------------------------------------------
// The table's rows
// ---------------------------------------------------------------------------

// The outcomes the Outcome header's filter offers, in its order: the
// problem statuses, then passed, skipped and the expected failures, then
// `other` (unexpected passes and unknown outcomes).
export const STATUS_CHOICES: readonly BundleStatus[] = [
  "failed",
  "timed_out",
  "flaky",
  "passed",
  "skipped",
  "xfailed",
  "other",
];

// What the Outcome filter's key says of the outcomes listed: nothing while
// every choice is listed, else the listed outcomes' titles, so the key
// reads as active whenever something is hidden, as it is by default.
export function statusesSummary(statuses: readonly BundleStatus[]): string {
  const hidden = STATUS_CHOICES.filter((status) => !statuses.includes(status));
  if (hidden.length === 0) return "";
  return phraseList(statuses.map((status) => STATUS_TITLES[status]));
}

type RunAttempt = RunRecord["attempts"][number];

// The rows of the table, in order: the runs, the rows of attempts under an
// expanded run, and the "Show more" row at the end.
export type CommitTableRow = { id: string } & (
  | {
      kind: "run";
      run: RunRecord;
      expanded: boolean;
      // Sorted by environment, all but the first of a run of rows in one
      // environment.
      environmentRepeated: boolean;
    }
  | { kind: "attempts"; run: RunRecord; group: AttemptGroup<RunAttempt> }
  | {
      kind: "more";
      // The next page is on its way.
      loading: boolean;
    }
);

export interface CommitTableInput {
  // The runs loaded, in the API's order.
  runs: readonly RunRecord[];
  // A further page is on its way.
  loadingMore: boolean;
  // Another page follows the loaded ones.
  hasMore: boolean;
  // The ids of the run rows whose attempts are shown.
  expanded: ReadonlySet<string>;
  sortedByEnvironment: boolean;
}

// A run row's id: its first attempt's, unique to the bundle.
export function runRowId(run: RunRecord): string {
  return run.attempts[0].id;
}

// The rows for what has arrived (CommitTableInput): every run loaded, each
// expanded run's attempts in groups under it, and while a page follows a
// "Show more" row, a shimmer while that page is on its way.
export function commitTableRows(input: CommitTableInput): CommitTableRow[] {
  const rows: CommitTableRow[] = [];
  let previousEnvironment: string | undefined;
  for (const run of input.runs) {
    const id = runRowId(run);
    const environment = run.environment?.id;
    rows.push({
      kind: "run",
      id,
      run,
      expanded: input.expanded.has(id),
      environmentRepeated:
        input.sortedByEnvironment &&
        environment !== undefined &&
        environment === previousEnvironment,
    });
    previousEnvironment = environment;
    if (input.expanded.has(id)) {
      for (const group of attemptGroups(run.attempts)) {
        rows.push({ kind: "attempts", id: `${id}:${group.first}`, run, group });
      }
    }
  }
  if (input.hasMore) {
    rows.push({ kind: "more", id: "more", loading: input.loadingMore });
  }
  return rows;
}

// The community data grid shows at most this many rows (its pages are
// capped at a hundred), so the table is one grid per this many rows, stacked
// as one table: the first with the header band, the rest without.
const MAX_GRID_ROWS = 100;

export function gridChunks<Row>(rows: readonly Row[]): Row[][] {
  const chunks: Row[][] = [];
  for (let start = 0; start < rows.length; start += MAX_GRID_ROWS) {
    chunks.push(rows.slice(start, start + MAX_GRID_ROWS));
  }
  return chunks.length === 0 ? [[]] : chunks;
}
