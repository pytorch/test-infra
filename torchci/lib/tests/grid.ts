import type { TestOptions } from "lib/api/tests/options/types";
import type {
  HealthStatus,
  HealthWindow,
  RanOn,
} from "lib/api/tests/parameters";
import type {
  RunGrid,
  RunGridCell,
  RunGridCommit,
  RunGridJob,
  RunGridLane,
  RunOutcome,
} from "lib/api/tests/test/runs/types";
import type { EnvironmentRecord, EnvVarsRecord } from "lib/api/tests/types";
import { FAILING_OUTCOMES } from "lib/runOutcomes";
import {
  CONFIG_VARIABLE,
  environmentTokens,
  variableLines,
} from "lib/tests/environment";
import { FacetOptions, menuOrder } from "lib/tests/facets";
import { COLUMN_HEADER_HEIGHT } from "lib/tests/layout";
import type { UrlQuery } from "lib/tests/url";
import { workflowName } from "lib/workflowName";

// The grid of a test's runs on the test's page: what GET
// /api/tests/test/{test_id}/runs?group_by=commit answers, read into lanes
// grouped by workflow and sorted worst first, each cell's status, the
// lanes' labels and counts, the day marks along the commits, the table's
// geometry, and the choices in its header. The component (RunGrid) draws;
// this decides.

// ---------------------------------------------------------------------------
// The header's choices: what the grid shows
// ---------------------------------------------------------------------------

// How a cell reads: passed, flaky when a failing attempt was followed by a
// pass, failed for any failing final outcome, skipped when nothing executed,
// other for the expected failures, unexpected passes and unknowns.
export type CellStatus = "passed" | "flaky" | "failed" | "skipped" | "other";

// The statuses as the header's menu lists them, worst first, with the word
// for each.
export const CELL_STATUSES: readonly CellStatus[] = [
  "failed",
  "flaky",
  "passed",
  "skipped",
  "other",
];
export const OUTCOME_LABELS: Record<CellStatus, string> = {
  failed: "Failed",
  flaky: "Flaky",
  passed: "Passed",
  skipped: "Skipped",
  other: "Other",
};

// The configuration a reader came to the page for: the list's row whose
// figure they clicked, named by its environment and env var set, the ids
// the list's entries carry (testRunsHref in lib/tests/links.ts). The grid
// marks every lane of that configuration, one per workflow, and scrolls the
// first into view (RunGrid).
export interface LanePin {
  environmentId: string;
  envVarsId: string;
}

export interface GridQuery {
  // The code sources whose runs are shown, in the options' order, never
  // empty. The list can combine main and pull requests, and an evidence
  // link from it keeps both, so the grid shows the runs the figure counted.
  ranOn: readonly RanOn[];
  window: HealthWindow;
  // The statuses whose cells are shown, in CELL_STATUSES' order; every
  // status unless the reader narrowed the grid, to the failures say.
  outcomes: readonly CellStatus[];
  // Whether the time bar runs under each configuration's pills.
  timeBar: boolean;
  // A commit hash, or the start of one, to find among the columns; "" when
  // none is sought.
  commit: string;
  // The configuration to mark; null when none.
  lane: LanePin | null;
}

// What the grid shows until the URL says otherwise: three days of main, long
// enough to see a test turn and short enough to keep one commit a column,
// every outcome shown, the time bar on, no configuration marked.
export const DEFAULT_GRID_RAN_ON: readonly RanOn[] = ["main"];
export const DEFAULT_GRID_WINDOW: HealthWindow = "3d";
export const DEFAULT_GRID_TIME_BAR = true;

// The statuses named in the URL's `outcomes`, comma-separated, put in the
// menu's order with the unknown dropped; every status when none is left.
function resolveOutcomes(value: string | string[] | undefined): CellStatus[] {
  const named = new Set(typeof value === "string" ? value.split(",") : []);
  const shown = CELL_STATUSES.filter((status) => named.has(status));
  return shown.length > 0 ? shown : [...CELL_STATUSES];
}

// The values of a parameter the API takes comma-separated or repeated,
// `ran_on=main,pull_request` or `ran_on=main&ran_on=pull_request`.
function urlValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (typeof value === "string" ? [value] : value).flatMap((each) =>
    each.split(",")
  );
}

// A catalog id as a URL may carry it, a UInt64 as a decimal string, as the
// API spells ids; anything else names nothing.
function urlId(value: string | string[] | undefined): string | null {
  return typeof value === "string" && /^\d{1,20}$/.test(value) ? value : null;
}

// The URL's choices, checked against the options: a value they do not offer
// falls back to the default, so the header always shows a real choice. A
// configuration is named by both its ids or not at all.
export function resolveGridQuery(
  url: UrlQuery,
  options: TestOptions
): GridQuery {
  const ranOn = menuOrder(urlValues(url.ran_on), options.ran_on.values);
  const window = menuOrder(
    typeof url.window === "string" ? [url.window] : [],
    options.window.values
  );
  const environmentId = urlId(url.environment);
  const envVarsId = urlId(url.env_vars);
  return {
    ranOn: ranOn.length > 0 ? ranOn : [...DEFAULT_GRID_RAN_ON],
    window: window[0] ?? DEFAULT_GRID_WINDOW,
    outcomes: resolveOutcomes(url.outcomes),
    timeBar: url.time_bar !== "0",
    commit: typeof url.commit === "string" ? url.commit.trim() : "",
    lane:
      environmentId !== null && envVarsId !== null
        ? { environmentId, envVarsId }
        : null,
  };
}

// Whether the code sources chosen are the default, main alone.
function defaultSources(ranOn: readonly RanOn[]): boolean {
  return (
    ranOn.length === DEFAULT_GRID_RAN_ON.length &&
    ranOn.every((source, index) => source === DEFAULT_GRID_RAN_ON[index])
  );
}

export function allOutcomesShown(outcomes: readonly CellStatus[]): boolean {
  return CELL_STATUSES.every((status) => outcomes.includes(status));
}

// The URL parameters of a query, the defaults left off; `outcomes`,
// `time_bar`, `commit`, `environment` and `env_vars` are the page's own,
// the API knowing nothing of them.
export function gridUrlParams(
  query: GridQuery
): Record<
  | "ran_on"
  | "window"
  | "outcomes"
  | "time_bar"
  | "commit"
  | "environment"
  | "env_vars",
  string | undefined
> {
  return {
    ran_on: defaultSources(query.ranOn) ? undefined : query.ranOn.join(","),
    window: query.window === DEFAULT_GRID_WINDOW ? undefined : query.window,
    outcomes: allOutcomesShown(query.outcomes)
      ? undefined
      : query.outcomes.join(","),
    time_bar: query.timeBar ? undefined : "0",
    commit: query.commit === "" ? undefined : query.commit,
    environment: query.lane === null ? undefined : query.lane.environmentId,
    env_vars: query.lane === null ? undefined : query.lane.envVarsId,
  };
}

// Whether the time bar has anything to say for the code sources shown: a
// stretch is a sustained change along one line of commits that build on
// one another, which main is and pull requests are not, each branching
// from main at its own point and most running once, so with pull requests
// among the sources the bar is off and its key unticked and disabled.
export function timeBarAvailable(ranOn: readonly RanOn[]): boolean {
  return !ranOn.includes("pull_request");
}

// Whether the time bar runs under the lanes: the reader's choice, kept in
// the URL either way, where the code sources allow one.
export function timeBarShown(
  query: Pick<GridQuery, "ranOn" | "timeBar">
): boolean {
  return timeBarAvailable(query.ranOn) && query.timeBar;
}

// The commit the header's search field names, among the grid's columns: the
// column whose hash starts with the text, case aside; or why there is none,
// so the field can say so (a hash outside the window is told
// so and pointed at the window).
export type CommitSearch =
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "none" }
  | { kind: "several"; count: number }
  | { kind: "found"; column: number };

export function commitSearch(
  commits: readonly Pick<RunGridCommit, "sha">[],
  text: string
): CommitSearch {
  const needle = text.trim().toLowerCase();
  if (needle === "") return { kind: "empty" };
  if (!/^[0-9a-f]{1,40}$/.test(needle)) return { kind: "invalid" };
  const columns = commits.flatMap((commit, column) =>
    commit.sha.toLowerCase().startsWith(needle) ? [column] : []
  );
  if (columns.length === 0) return { kind: "none" };
  if (columns.length > 1) return { kind: "several", count: columns.length };
  return { kind: "found", column: columns[0] };
}

// What the search field says under itself: nothing while the text is empty
// or names one column; else that the text is no hash, that no commit of
// the code source in the window starts with it (and what to do), or that
// several do.
export function commitSearchMessage(
  search: CommitSearch,
  text: string,
  ranOnLabel: string,
  windowLabel: string
): string | null {
  switch (search.kind) {
    case "invalid":
      return "A commit hash is hex digits only, 0-9 and a-f.";
    case "none":
      return `No commit starting with ${text.trim()} in the ${windowLabel} of ${ranOnLabel}. Widen the window, or check the hash.`;
    case "several":
      return `${
        search.count
      } commits start with ${text.trim()}. Type more of the hash.`;
    default:
      return null;
  }
}

// What the outcomes key reads: "All outcomes", the one or two shown by
// name, or how many are shown.
export function outcomesLabel(outcomes: readonly CellStatus[]): string {
  if (allOutcomesShown(outcomes)) return "All outcomes";
  if (outcomes.length <= 2) {
    return outcomes.map((status) => OUTCOME_LABELS[status]).join(", ");
  }
  return `${outcomes.length} outcomes`;
}

// The outcomes shown as a phrase for the empty sentence: "failed or flaky".
export function outcomesPhrase(outcomes: readonly CellStatus[]): string {
  const words = outcomes.map((status) => OUTCOME_LABELS[status].toLowerCase());
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

// Where the API answers the grid for a test and a query.
export function testGridApiUrl(testId: string, query: GridQuery): string {
  const params = new URLSearchParams({
    group_by: "commit",
    ran_on: query.ranOn.join(","),
    window: query.window,
  });
  return `/api/tests/test/${encodeURIComponent(testId)}/runs?${params}`;
}

// ---------------------------------------------------------------------------
// The header's hover help
// ---------------------------------------------------------------------------

// What each column header says on hover, in the voice of the list page's
// tooltips (descriptionsFor in TestsTable.tsx): a plain sentence or two, a
// legend line per color where one helps, the window named as the list
// names it ("within the last 7 days"; "within the window" until the choices
// are known).
export interface HeaderDescriptions {
  configuration: string;
  outcomes: string;
  runs: string;
}

export function headerDescriptions(
  windowLabel: string | undefined,
  timeBar: boolean
): HeaderDescriptions {
  const within =
    windowLabel === undefined
      ? "within the window"
      : `within the last ${windowLabel}`;
  const runs = [
    "The test's result on each commit, newest on the left.",
    "Green: passed.",
    "Yellow: passed on retry.",
    "Red: failed.",
    "Purple: skipped.",
    "A pill splits when a retry changed the result: first attempt on top, final below. If several jobs ran the test on a commit, the worst result wins.",
  ];
  if (timeBar) {
    runs.push(
      "Under the pills, the bar groups commits that take about the same time. The oldest group is grey, newer ones red when slower and green when faster."
    );
  }
  return {
    configuration:
      "The configuration the test ran in: the test config and the device, then the Python version, OS, CPU and compiler. +N vars means more env vars were set. Click it to see them.",
    outcomes: [
      "How many commits passed, failed or were skipped in this configuration. Expected failures, unexpected passes and unknowns are shown but not counted.",
      "Green: passed.",
      "Yellow: failed, but all passed on retry.",
      "Red: failed.",
      "Purple: skipped.",
      `Under the counts, the median time a passing run takes ${within}. The bar compares it with the slowest configuration in the table.`,
    ].join("\n"),
    runs: runs.join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

// A cell's jobs and what decided it, by the API's rule (RunGridCellSchema):
// the decisive job holds the deciding attempt of the retry sequence the
// cell's outcome comes from, and that sequence is the jobs of the decisive
// job's name, a job and its re-run in the order they started (a job without
// a name is a sequence of its own). A sibling job, another shard that ran the test, is
// no part of it: its attempts are not reruns of the decisive job's, and
// the page never reads them as one chain (two inductor_core shards' runs had
// read as a timeout rerun twice).
export type CellJobs = Pick<RunGridCell, "jobs">;

export function decisiveJob(cell: CellJobs): RunGridJob {
  return (
    cell.jobs.find((job) => job.decisive) ?? cell.jobs[cell.jobs.length - 1]
  );
}

export function decisiveSequence(cell: CellJobs): RunGridJob[] {
  const decisive = decisiveJob(cell);
  if (decisive.job_name === null) return [decisive];
  return cell.jobs.filter((job) => job.job_name === decisive.job_name);
}

// The attempts the cell's outcome was judged on, in order: the deciding
// sequence's, a rerun after the attempt it reran.
export function decisiveAttempts(cell: CellJobs): RunOutcome[] {
  return decisiveSequence(cell).flatMap((job) => job.attempts);
}

// The cell's jobs as the card lists them: the deciding sequence first,
// since the headline is its, then the others in the order they started.
export function cardJobs(cell: CellJobs): RunGridJob[] {
  const deciding = new Set(decisiveSequence(cell));
  return [
    ...cell.jobs.filter((job) => deciding.has(job)),
    ...cell.jobs.filter((job) => !deciding.has(job)),
  ];
}

export function cellStatus(
  cell: Pick<RunGridCell, "outcome" | "jobs">
): CellStatus {
  if (cell.outcome === "skipped") return "skipped";
  if (cell.outcome === "passed") {
    const failedBefore = decisiveAttempts(cell).some((outcome) =>
      FAILING_OUTCOMES.has(outcome)
    );
    return failedBefore ? "flaky" : "passed";
  }
  return FAILING_OUTCOMES.has(cell.outcome) ? "failed" : "other";
}

// Whether the test passed on the commit in the end, on its first attempt
// or a retry: the cells that have a passing time, for the time bar.
export function passedEventually(
  cell: Pick<RunGridCell, "outcome" | "jobs">
): boolean {
  const status = cellStatus(cell);
  return status === "passed" || status === "flaky";
}

// The time the card leads with: a pass's passed time, which the API gives
// as one run's time, the mean over the sibling sequences that passed and,
// within a sequence, over its jobs that passed, of the attempts that passed
// alone, so a run that recovered is timed by its pass and two shards, or a
// job and its re-run, that both passed count as one run; else the deciding
// sequence's executed time, a timeout's thirty minutes without a sibling's
// run. The whole spend is duration_milliseconds.
export function cellTime(
  cell: Pick<RunGridCell, "outcome" | "jobs" | "passed_duration_milliseconds">
): number {
  return passedEventually(cell)
    ? cell.passed_duration_milliseconds
    : decisiveSequence(cell).reduce(
        (sum, job) => sum + job.duration_milliseconds,
        0
      );
}

// How a run is split: the status of its first attempt, drawn above how the
// run ended (cellStatus, so a pass after a failure is the flaky yellow),
// when the two differ. The attempts are the deciding sequence's: a sibling
// shard's run is no rerun and does not stand above how this one ended.
// Null for a run drawn as one pill: one attempt, attempts that all ended
// the same way, and attempts that ended differently without changing how
// the run ended, a timeout whose rerun was skipped above all (red over red
// would say nothing). Two capsules, since the attempts banded inside one
// pill were too hard to read at the narrow cells a week of main gives.
export interface AttemptSplit {
  first: CellStatus;
  last: CellStatus;
}

export function attemptSplit(
  cell: Pick<RunGridCell, "outcome" | "jobs">
): AttemptSplit | null {
  const attempts = decisiveAttempts(cell);
  if (attempts.length < 2) return null;
  const first = attemptStatus(attempts[0]);
  const last = cellStatus(cell);
  return first === last ? null : { first, last };
}

// An outcome as a word a tooltip opens with.
export const OUTCOME_WORDS: Record<RunOutcome, string> = {
  unknown: "Unknown",
  passed: "Passed",
  failed: "Failed",
  error: "Error",
  skipped: "Skipped",
  xfailed: "Expected failure",
  xpassed: "Unexpected pass",
  crashed: "Crashed",
  timed_out: "Timed out",
};

// The cell's headline: "Flaky" for a run that recovered, else the recorded
// outcome it settled on, "Timed out".
export function cellHeadline(
  cell: Pick<RunGridCell, "outcome" | "jobs">
): string {
  return cellStatus(cell) === "flaky" ? "Flaky" : OUTCOME_WORDS[cell.outcome];
}

// The status one attempt's outcome reads as, for its pill on the card:
// green for a pass, red for a failure, purple for a skip, plain for the
// rest (an expected failure, an unexpected pass, unknown).
export function attemptStatus(outcome: RunOutcome): CellStatus {
  if (outcome === "passed") return "passed";
  if (outcome === "skipped") return "skipped";
  return FAILING_OUTCOMES.has(outcome) ? "failed" : "other";
}

// ---------------------------------------------------------------------------
// Lanes and groups
// ---------------------------------------------------------------------------

export interface GridLane {
  key: string;
  environment: EnvironmentRecord | null;
  envVars: EnvVarsRecord | null;
  // The label's first line, "default · CUDA 13.2 · NVIDIA L4": the config,
  // then what torch was built for and ran on, as the list page's
  // Environment cell leads with them.
  tokens: string[];
  // The label's second line, muted, "Python 3.11 · Linux 22.04 · x86_64
  // avx512 · GCC 11.4": the interpreter and the platform, as that cell's
  // second line; empty without an environment.
  details: string[];
  // The variables set besides the config, "PYTORCH_TEST_WITH_SLOW=1", in
  // name order; counted in the badge, listed when the lane is expanded.
  variables: string[];
  status: HealthStatus;
  passed: number;
  // Cells with a failing attempt, recovered or not, as health counts them.
  failed: number;
  skipped: number;
  cells: ReadonlyMap<string, RunGridCell>;
}

export interface GridGroup {
  workflowPath: string | null;
  // The workflow's file, "pull.yml"; "unknown workflow" without a path.
  name: string;
  status: HealthStatus;
  lanes: GridLane[];
}

// Worst first, as the list page ranks them; skipped, which has no runs,
// last.
const STATUS_RANK: Record<HealthStatus, number> = {
  failing: 0,
  flaky: 1,
  healthy: 2,
  skipped: 3,
};

// The lane's status from its cells, by the health view's rule: failing with
// any failure that stood, flaky when every failure was recovered, healthy
// when something executed, skipped when nothing did.
export function laneStatus(cells: Iterable<RunGridCell>): HealthStatus {
  let status: HealthStatus = "skipped";
  for (const cell of cells) {
    switch (cellStatus(cell)) {
      case "failed":
        return "failing";
      case "flaky":
        status = "flaky";
        break;
      case "passed":
      case "other":
        if (status === "skipped") status = "healthy";
        break;
    }
  }
  return status;
}

// Whether a lane is the configuration the reader came for: its environment
// and env var set are the pin's. A pin names one configuration, which has a
// lane under each workflow that ran it.
export function lanePinned(
  lane: Pick<GridLane, "environment" | "envVars">,
  pin: LanePin | null
): boolean {
  return (
    pin !== null &&
    lane.environment !== null &&
    lane.envVars !== null &&
    lane.environment.id === pin.environmentId &&
    lane.envVars.id === pin.envVarsId
  );
}

// A lane's label as the list page's Config and Environment cells set the
// same things: the config leads the first line, then the environment's
// primary tokens, what torch was built for and ran on; its secondary
// tokens, the interpreter and the platform, make the second line. Labels
// come from the options when there are any, the catalog's spelling
// otherwise. The whole environment, field by field, is in the label's
// tooltip.
export interface LaneLines {
  tokens: string[];
  details: string[];
}

export function laneLines(
  lane: Pick<RunGridLane, "environment" | "env_vars">,
  options: FacetOptions | undefined
): LaneLines {
  const tokens: string[] = [];
  const config = lane.env_vars?.values[CONFIG_VARIABLE];
  if (config !== undefined && config !== "") tokens.push(config);
  if (lane.environment === null) {
    return {
      tokens: tokens.length ? tokens : ["unknown environment"],
      details: [],
    };
  }
  const { primary, secondary } = environmentTokens(lane.environment, options);
  tokens.push(...primary.map((token) => token.text));
  return {
    tokens: tokens.length ? tokens : ["unknown configuration"],
    details: secondary.map((token) => token.text),
  };
}

export const UNKNOWN_WORKFLOW = "unknown workflow";

// A lane's counts of its cells: passed, failed (every cell with a failing
// attempt, recovered or not, as health counts them) and skipped.
function countCells(cells: Iterable<RunGridCell>): {
  passed: number;
  failed: number;
  skipped: number;
} {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const cell of cells) {
    const status = cellStatus(cell);
    if (status === "passed") passed += 1;
    else if (status === "failed" || status === "flaky") failed += 1;
    else if (status === "skipped") skipped += 1;
  }
  return { passed, failed, skipped };
}

// Within a workflow, the lanes in label order: the config first, then the
// environment's two lines, then the variables, numbers compared as
// numbers, so one config's environments sit together and "CUDA 13.2"
// precedes "CUDA 13.4" (worst first had scattered the
// configurations a reader wants side by side).
const LANE_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export function compareLanes(
  left: Pick<GridLane, "tokens" | "details" | "variables">,
  right: Pick<GridLane, "tokens" | "details" | "variables">
): number {
  return (
    LANE_COLLATOR.compare(left.tokens.join(" "), right.tokens.join(" ")) ||
    LANE_COLLATOR.compare(left.details.join(" "), right.details.join(" ")) ||
    LANE_COLLATOR.compare(left.variables.join(" "), right.variables.join(" "))
  );
}

// The API's lanes read into the page's: grouped under their workflow, the
// groups worst first and then by how much ran, the lanes within a workflow
// in label order; the options label the environments' tokens.
export function gridGroups(grid: RunGrid, options?: FacetOptions): GridGroup[] {
  const groups = new Map<string | null, GridGroup>();
  for (const [index, apiLane] of grid.lanes.entries()) {
    const cells = new Map(apiLane.cells.map((cell) => [cell.commit_sha, cell]));
    const lane: GridLane = {
      key: `${apiLane.workflow_path ?? ""}|${
        apiLane.environment?.id ?? index
      }|${apiLane.env_vars?.id ?? index}`,
      environment: apiLane.environment,
      envVars: apiLane.env_vars,
      ...laneLines(apiLane, options),
      variables:
        apiLane.env_vars === null
          ? []
          : variableLines(apiLane.env_vars, { withoutConfig: true }),
      status: laneStatus(apiLane.cells),
      ...countCells(apiLane.cells),
      cells,
    };
    let group = groups.get(apiLane.workflow_path);
    if (group === undefined) {
      group = {
        workflowPath: apiLane.workflow_path,
        name:
          apiLane.workflow_path === null
            ? UNKNOWN_WORKFLOW
            : workflowName(apiLane.workflow_path),
        status: "skipped",
        lanes: [],
      };
      groups.set(apiLane.workflow_path, group);
    }
    group.lanes.push(lane);
    if (STATUS_RANK[lane.status] < STATUS_RANK[group.status]) {
      group.status = lane.status;
    }
  }
  const executed = (lanes: GridLane[]) =>
    lanes.reduce((sum, lane) => sum + lane.passed + lane.failed, 0);
  for (const group of groups.values()) {
    group.lanes.sort(compareLanes);
  }
  return Array.from(groups.values()).sort(
    (left, right) =>
      STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
      executed(right.lanes) - executed(left.lanes) ||
      left.name.localeCompare(right.name)
  );
}

// The groups narrowed to the outcomes shown: each lane keeps the cells of
// those statuses, counts them alone and takes its status from them, so the
// failed count's swatch and the muting of a lane follow what is shown (a
// lane narrowed to its recoveries had kept a red swatch beside yellow
// cells); a lane with none left and a workflow with no lane left drop out,
// and the order and the lanes' labels stay as they were. The groups
// themselves when every outcome is shown.
export function filterGroups(
  groups: GridGroup[],
  outcomes: readonly CellStatus[]
): GridGroup[] {
  if (allOutcomesShown(outcomes)) return groups;
  const shown = new Set(outcomes);
  const narrowed: GridGroup[] = [];
  for (const group of groups) {
    const lanes: GridLane[] = [];
    for (const lane of group.lanes) {
      const cells = new Map(
        Array.from(lane.cells).filter(([, cell]) => shown.has(cellStatus(cell)))
      );
      if (cells.size > 0) {
        lanes.push({
          ...lane,
          status: laneStatus(cells.values()),
          ...countCells(cells.values()),
          cells,
        });
      }
    }
    if (lanes.length > 0) narrowed.push({ ...group, lanes });
  }
  return narrowed;
}

// ---------------------------------------------------------------------------
// The commits across
// ---------------------------------------------------------------------------

// The grid's columns: the API's commits, oldest first, turned around so
// the newest stands first, at the left beside the counts, where a reader
// looks first and where HUD's own grid puts the newest commit; time runs
// rightward into the past.
export function columnCommits(grid: Pick<RunGrid, "commits">): RunGridCommit[] {
  return [...grid.commits].reverse();
}

export interface DayMark {
  // The first column of the day, in the columns' order.
  index: number;
  date: Date;
  weekend: boolean;
}

// Where the local date changes along the columns, in their order: the
// first column of each day, the first day included.
export function dayMarks(commits: readonly RunGridCommit[]): DayMark[] {
  const marks: DayMark[] = [];
  let last: string | undefined;
  for (const [index, commit] of commits.entries()) {
    const date = new Date(commit.started_at);
    const day = date.toDateString();
    if (day !== last) {
      marks.push({
        index,
        date,
        weekend: date.getDay() === 0 || date.getDay() === 6,
      });
      last = day;
    }
  }
  return marks;
}

// The columns' geometry for a plot with the given room: each commit a step
// apart, with a cell no wider than a comfortable square, the rest of the
// step a gap. A cell is never narrower than MIN_CELL_WIDTH: when the
// commits would need less, the step holds at that cell and a pixel of gap
// and the plot grows past the room, to scroll sideways under the fixed
// columns (a cell under three pixels lost its whole width to its edge and
// drew nothing, so a pull request week, some 1,400 commits, was blank).
const MAX_CELL_WIDTH = 14;
export const MIN_CELL_WIDTH = 4;

export function columnLayout(
  columns: number,
  room: number
): { step: number; gap: number; cellWidth: number; plotWidth: number } {
  if (columns === 0 || room <= 0) {
    return { step: 0, gap: 0, cellWidth: 0, plotWidth: Math.max(0, room) };
  }
  const fitted = room / columns;
  const narrowest = MIN_CELL_WIDTH + 1;
  const step = Math.max(fitted, narrowest);
  const gap = step >= 6 ? 2 : 1;
  const cellWidth = Math.max(
    MIN_CELL_WIDTH,
    Math.min(MAX_CELL_WIDTH, Math.floor(step) - gap)
  );
  return {
    step,
    gap,
    cellWidth,
    plotWidth: fitted >= narrowest ? room : columns * narrowest,
  };
}

// A cell is a pill: its corners are rounded by half its shorter side, so a
// cell taller than it is wide is a capsule and a thin cell is nearly round.
export function cellRadius(cellWidth: number, cellHeight: number): number {
  return Math.min(cellWidth, cellHeight) / 2;
}

// How far a cell grows on every side while the pointer is over it, drawn
// over its neighbors.
export const CELL_HOVER_GROWTH = 2;

// A cell's edge is one pixel wide and drawn inside its box, so it does not
// eat the gap to the next cell: the rectangle the edge is drawn on is the
// box shrunk by half the edge on every side, as is the hovered cell's
// thicker ring, so a split run's gap stays the gap.
export const CELL_EDGE = 1;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function edgedBox(box: Box, edge: number = CELL_EDGE): Box {
  const inset = edge / 2;
  return {
    x: box.x + inset,
    y: box.y + inset,
    width: Math.max(0, box.width - edge),
    height: Math.max(0, box.height - edge),
  };
}

// A split run's two capsules in a cell's box: each as tall as half the
// box less the gap of the page between them, the first at the top, the
// last at the bottom.
export function splitBoxes(box: Box): { first: Box; last: Box } {
  const height = (box.height - GRID_SIZES.splitGap) / 2;
  return {
    first: { ...box, height },
    last: { ...box, y: box.y + box.height - height, height },
  };
}

// The shapes a cell is drawn with in a box: one pill in its status, or a
// split run's two capsules each in its own (attemptSplit, splitBoxes).
// The cell under the pointer is drawn the same way in a grown box.
export interface CellPart {
  box: Box;
  status: CellStatus;
}

export function cellParts(
  cell: Pick<RunGridCell, "outcome" | "jobs">,
  box: Box
): CellPart[] {
  const split = attemptSplit(cell);
  if (split === null) return [{ box, status: cellStatus(cell) }];
  const boxes = splitBoxes(box);
  return [
    { box: boxes.first, status: split.first },
    { box: boxes.last, status: split.last },
  ];
}

// The table's geometry, after the list table's: a header band the height of
// its column headers, holding the column titles and the choices; a row for
// each workflow in the band's grey with its name; lanes a little taller
// than a line of small text, with a hairline between them, every cell one
// height, every run pill the same size: 12px tall with 4px of air above and
// below in a bare lane, tall enough for a split run's two capsules; and a
// footer band in the header's grey for the day labels. A lane's three
// counts stand in one Outcomes column,
// each in a slot wide enough for a swatch and a figure of four digits with
// the thousands separator, the configuration's median window time and its
// bar on the column's second line, and the commits begin after a gap.
export const GRID_SIZES = {
  headerHeight: COLUMN_HEADER_HEIGHT,
  sectionHeight: 24,
  laneHeight: 20,
  cellHeight: 12,
  // A run whose first attempt ended differently from how it ended is two
  // capsules, the first attempt's status above how the run ended, with
  // this much of the page between them (attemptSplit, splitBoxes).
  splitGap: 2,
  // A configuration with passes grows to a lane with its pills on an upper
  // row and its time bar under them, the stretches of one typical time as
  // blocks labelled with that time. The Outcomes column's second line
  // holds the typical time, the median window time: its figure ("12.5
  // min") left-aligned under the first swatch, the bar a short gap after
  // the widest figure, at most this wide and cut to the column.
  timedLaneHeight: 40,
  pillRowCenter: 12,
  timeBarTop: 22,
  timeBarHeight: 14,
  typicalBarWidth: 56,
  // A label's lines are this far apart; a lane with the two lines of a
  // known environment is as tall as a timed lane, and a lane with one line
  // and a badge keeps this much air around the badge. The badge counting a
  // lane's variables sits at the label column's right edge on the label's
  // last line: this tall, this much padding at its sides, this far from
  // the line's text. Expanded, it opens into a panel under the label with
  // this much padding around the variables' lines, and the lane grows
  // downward by the panel and this much air under it, so nothing above
  // moves.
  labelLineHeight: 14,
  twoLineLaneHeight: 40,
  // A stretch's block is at least this wide: a configuration's lone pass
  // or two would otherwise be a sliver of a pixel with nothing to see or
  // for the label to follow.
  stretchMinWidth: 6,
  badgedLaneHeight: 26,
  badgeHeight: 18,
  badgePadding: 6,
  badgeGap: 8,
  panelPadding: 6,
  expandedPadding: 6,
  axisHeight: 30,
  // While a commit is pinned from the search field, the footer strip grows
  // by a second row for its pill, under the day labels and the pointer's
  // pill, so the two pills never cover each other (on one row the
  // pinned pill sat over the pointer's).
  pinnedRowHeight: 22,
  // While the plot is wider than its room, the strip grows by a row at its
  // bottom edge for the scrollbar, a thin one, which scrolls the plot and
  // the day labels together.
  scrollbarRowHeight: 10,
  // An outcome's slot: its swatch inset from the slot's left, its figure
  // a short gap after the swatch, and room for four digits with the
  // thousands separator before the next slot.
  outcomeSlot: 52,
  outcomeInset: 6,
  swatchWidth: 6,
  figureGap: 5,
  plotGap: 20,
  // Where a workflow's name and a lane's label start.
  sectionIndent: 12,
  laneIndent: 24,
} as const;

// The outcomes a lane counts, in the order their slots stand; each is a
// field of GridLane.
export const COUNT_COLUMNS = ["passed", "failed", "skipped"] as const;
export type CountColumn = (typeof COUNT_COLUMNS)[number];

export interface OutcomeSlot {
  swatchX: number;
  // Where the figure starts, after the swatch.
  figureX: number;
}

export interface GridColumns {
  outcomes: OutcomeSlot[];
  // Where the typical time's figure starts on the Outcomes column's second
  // line, under the first swatch, where its bar starts, a short gap after
  // the widest figure, and how wide the bar may be within the column.
  typicalFigureX: number;
  typicalBarX: number;
  typicalBarWidth: number;
  // The rules between the header's columns: after the labels and after the
  // outcomes.
  rules: number[];
  // Where the commits begin.
  plotX: number;
}

// The widest typical time figure the column is laid out for before the
// lanes are known: "12.9 min".
export const DEFAULT_TYPICAL_FIGURE_WIDTH = 52;

// How tall the footer strip is: the day labels' row, a second row for the
// pinned commit's pill while a commit is pinned, and a row for the
// scrollbar while the plot is wider than its room.
export function footerHeight(
  pinned: boolean,
  scrollable: boolean = false
): number {
  return (
    GRID_SIZES.axisHeight +
    (pinned ? GRID_SIZES.pinnedRowHeight : 0) +
    (scrollable ? GRID_SIZES.scrollbarRowHeight : 0)
  );
}

// The columns' positions for a label column this wide and typical time
// figures at most this wide.
export function gridColumns(
  labelWidth: number,
  typicalFigureWidth: number = DEFAULT_TYPICAL_FIGURE_WIDTH
): GridColumns {
  const outcomes = COUNT_COLUMNS.map((_column, index) => {
    const swatchX =
      labelWidth + index * GRID_SIZES.outcomeSlot + GRID_SIZES.outcomeInset;
    return {
      swatchX,
      figureX: swatchX + GRID_SIZES.swatchWidth + GRID_SIZES.figureGap,
    };
  });
  const outcomesRight =
    labelWidth + COUNT_COLUMNS.length * GRID_SIZES.outcomeSlot;
  const typicalFigureX = outcomes[0].swatchX;
  const typicalBarX =
    typicalFigureX + typicalFigureWidth + GRID_SIZES.figureGap;
  return {
    outcomes,
    typicalFigureX,
    typicalBarX,
    typicalBarWidth: Math.max(
      0,
      Math.min(
        GRID_SIZES.typicalBarWidth,
        outcomesRight - GRID_SIZES.outcomeInset - typicalBarX
      )
    ),
    rules: [labelWidth, outcomesRight],
    plotX: outcomesRight + GRID_SIZES.plotGap,
  };
}

// The time bar's rule, from a configuration's passes alone, since a
// failure's time is mostly a timeout's, taken oldest first. The level
// at a pass is the median of the TIME_ROLL passes around it, so one slow
// run moves nothing. A new stretch begins at the first of TIME_HOLD passes
// in a row whose level sits more than TIME_THRESHOLD off the current
// stretch's median: a change has to hold to count, which is what makes it
// a change in how long the test takes rather than a slow afternoon.
// Neighbouring stretches whose medians end up within the threshold are
// merged, closest pair first, until none are, since a merge can bring two
// others within reach. The first stretch has no rule to hold by, so one
// shorter than TIME_ROLL passes, whose level would rest on fewer passes
// than the rolling median every other boundary is judged by, is folded
// into the one after it: a lane's first run alone never makes a stretch
// either. The threshold is a fraction of the time, but of no less than
// TIME_FLOOR_MS of it: the times are whole milliseconds, so a test of a
// few milliseconds is a millisecond off every other run, which is a
// third of its time and nothing at all (a 2 ms test cut into a dozen
// stretches labelled "+100%"); and a test that takes no
// time has no fraction to be off by, so a stretch at 0 ms could never
// end. Against a tenth of a second, a millisecond is 1%, and a change
// counts once it is at least 15 ms.
const TIME_ROLL = 5;
const TIME_THRESHOLD = 0.15;
const TIME_HOLD = 6;
export const TIME_FLOOR_MS = 100;

// How far `time` stands from `level`, as a fraction of the level, or of
// the floor when the level is under it.
function timeChange(time: number, level: number): number {
  return Math.abs(time - level) / Math.max(level, TIME_FLOOR_MS);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[half]
    : (sorted[half - 1] + sorted[half]) / 2;
}

// The median of the `span` values around each one, the window pulled in
// at the ends so it always holds `span` values when there are that many.
function rollingMedian(
  values: readonly number[],
  span: number = TIME_ROLL
): number[] {
  return values.map((_value, index) => {
    const end = Math.min(
      values.length,
      Math.max(0, index - Math.floor(span / 2)) + span
    );
    const start = Math.max(0, end - span);
    return median(values.slice(start, end));
  });
}

export interface Stretch {
  // The passes it spans, as indexes into the lane's passes, the end left
  // out.
  from: number;
  to: number;
  // Its typical time, the median of its passes, in milliseconds.
  level: number;
  // How its level stands to the stretch before, as a fraction (0.44 for
  // 44% longer); null for the first stretch.
  change: number | null;
}

export function stretches(values: readonly number[]): Stretch[] {
  if (values.length === 0) return [];
  const rolled = rollingMedian(values);
  const off = (index: number, level: number) =>
    timeChange(rolled[index], level) > TIME_THRESHOLD;
  const spans: [number, number][] = [];
  let start = 0;
  let index = 1;
  while (index < values.length) {
    const level =
      index - start >= 2 ? median(values.slice(start, index)) : values[start];
    if (off(index, level)) {
      let held = 0;
      while (index + held < values.length && off(index + held, level)) {
        held += 1;
      }
      if (held >= TIME_HOLD) {
        spans.push([start, index]);
        start = index;
        index += TIME_HOLD;
        continue;
      }
    }
    index += 1;
  }
  spans.push([start, values.length]);
  if (spans.length > 1 && spans[0][1] - spans[0][0] < TIME_ROLL) {
    spans.splice(0, 2, [0, spans[1][1]]);
  }
  const levelOf = (span: [number, number]) =>
    median(values.slice(span[0], span[1]));
  while (spans.length > 1) {
    let closest = 0;
    let gap = Infinity;
    for (let pair = 0; pair < spans.length - 1; pair += 1) {
      const apart = timeChange(levelOf(spans[pair + 1]), levelOf(spans[pair]));
      if (apart < gap) {
        gap = apart;
        closest = pair;
      }
    }
    if (gap > TIME_THRESHOLD) break;
    spans.splice(closest, 2, [spans[closest][0], spans[closest + 1][1]]);
  }
  return spans.map(([from, to], position) => {
    const level = levelOf([from, to]);
    const before = position === 0 ? null : levelOf(spans[position - 1]);
    return {
      from,
      to,
      level,
      change: before === null || before <= 0 ? null : level / before - 1,
    };
  });
}

// A configuration's times as its lane needs them: the columns of its
// passes, oldest first, with their times (the columns run newest first, so
// the column numbers descend), a run that passed only on a
// retry among them with the time of the attempts that passed (a flaky run
// still passes; its summed time would be the
// failed attempt's, a 300 s crash against a 1 s pass); the median of those
// times, the figure under the lane's counts, null when nothing passed; and the
// stretches the time bar draws. A cell's time is the API's passed time,
// one run's time: the mean over the sibling sequences that passed and,
// within a sequence, over its jobs that passed, so two shards, or a job and
// its re-run, that both passed count as one run (added up, a re-run's
// two jobs had made 99 of one test's 1,780 passing cells about twice as
// long). The median across the commits rather than the
// mean, so one slow run moves the figure little.
export interface LaneTimes {
  columns: number[];
  durations: number[];
  typical: number | null;
  stretches: Stretch[];
}

export function laneTimes(
  lane: Pick<GridLane, "cells">,
  commits: readonly Pick<RunGridCommit, "sha">[]
): LaneTimes {
  const columns: number[] = [];
  const durations: number[] = [];
  // From the last column, the oldest commit, to the first, the newest, so
  // the passes are in time order for the stretches.
  for (let column = commits.length - 1; column >= 0; column -= 1) {
    const cell = lane.cells.get(commits[column].sha);
    if (cell !== undefined && passedEventually(cell)) {
      columns.push(column);
      durations.push(cell.passed_duration_milliseconds);
    }
  }
  return {
    columns,
    durations,
    typical: durations.length === 0 ? null : median(durations),
    stretches: stretches(durations),
  };
}

// Where a stretch's label goes and how much of it: inside its block when
// the block has room for the change and the time, the time alone, or the
// change alone, in that order, since the tint already says which way a
// change went; else to the right of the block, in the room before the
// older block there or the plot's end, the same order; else nowhere, the
// card having it.
export type StretchLabelForm = "both" | "level" | "change";
export interface StretchLabel {
  form: StretchLabelForm;
  outside: boolean;
}

export function stretchLabel(
  texts: { level: string; change: string | null },
  insideRoom: number,
  outsideRoom: number
): StretchLabel | null {
  const both =
    texts.change === null ? null : `${texts.change} \u00b7 ${texts.level}`;
  const formFor = (room: number): StretchLabelForm | null => {
    if (both !== null && estimatedTextWidth(both) <= room) return "both";
    if (estimatedTextWidth(texts.level) <= room) return "level";
    if (texts.change !== null && estimatedTextWidth(texts.change) <= room) {
      return "change";
    }
    return null;
  };
  const inside = formFor(insideRoom);
  if (inside !== null) return { form: inside, outside: false };
  const outside = formFor(outsideRoom);
  return outside === null ? null : { form: outside, outside: true };
}

// The stretch whose block covers this commit column: from its oldest
// pass's column to its newest's, the columns between them included,
// whichever way the columns run; null off every block.
export function stretchAtColumn(
  times: Pick<LaneTimes, "columns" | "stretches">,
  column: number
): Stretch | null {
  return (
    times.stretches.find((stretch) => {
      const oldest = times.columns[stretch.from];
      const newest = times.columns[stretch.to - 1];
      return (
        Math.min(oldest, newest) <= column && column <= Math.max(oldest, newest)
      );
    }) ?? null
  );
}

// How a stretch's level stands to the oldest stretch's, for its block's
// tint: the same within a tenth of the oldest's time (of the floor, under
// it), else slower or faster.
export type StretchTone = "same" | "slower" | "faster";
const STRETCH_TONE_BAND = 0.1;

export function stretchTone(level: number, oldest: number): StretchTone {
  if (timeChange(level, oldest) <= STRETCH_TONE_BAND) return "same";
  return level > oldest ? "slower" : "faster";
}

// A change as a block or a card says it: "+44%", "\u22128%", "0%" within
// half a percent, and a dash when there is none to give.
export function changeLabel(change: number | null): string {
  if (change === null) return "\u2014";
  const percent = Math.round(change * 100);
  if (percent === 0) return "0%";
  return percent > 0 ? `+${percent}%` : `\u2212${-percent}%`;
}

// The status an outcome's swatch takes beside a lane's count: the color of
// the cells it counts. A lane's failed count is every cell with a failing
// attempt, as health counts them, so its swatch is yellow when every one of
// them recovered and red otherwise.
export function outcomeSwatchStatus(
  column: CountColumn,
  lane: Pick<GridLane, "status">
): CellStatus {
  if (column === "failed") {
    return lane.status === "flaky" ? "flaky" : "failed";
  }
  return column;
}

export interface GridSectionRow {
  group: GridGroup;
  top: number;
}

export interface GridLaneRow {
  group: GridGroup;
  lane: GridLane;
  top: number;
  height: number;
}

export interface GridRows {
  sections: GridSectionRow[];
  lanes: GridLaneRow[];
  // Where the last lane ends and the footer begins.
  bottom: number;
}

// The dot between a label's tokens, and between the card's.
export const LABEL_SEPARATOR = " \u00b7 ";

// The badge counting a lane's variables besides the config, "+3 vars", as
// the list page's Config cell counts them, and how wide it is before the
// browser has set it: its text at the table's size with the padding at
// either side. A click on it expands the lane to list them.
export function badgeLabel(count: number): string {
  return `+${count} var${count === 1 ? "" : "s"}`;
}

export function estimatedBadgeWidth(count: number): number {
  return estimatedTextWidth(badgeLabel(count)) + 2 * GRID_SIZES.badgePadding;
}

// How tall this lane is folded: a timed lane, 40px, when the configuration
// has a pass, for its time bar and for the time line under its counts
// (time bar or not); the same for the two lines of a
// known environment; 26px for one line with a badge, so the badge has air;
// 20px for one line alone.
export function foldedLaneHeight(
  lane: Pick<GridLane, "cells" | "details" | "variables">
): number {
  let height: number = GRID_SIZES.laneHeight;
  if (lane.details.length > 0) height = GRID_SIZES.twoLineLaneHeight;
  else if (lane.variables.length > 0) height = GRID_SIZES.badgedLaneHeight;
  for (const cell of lane.cells.values()) {
    if (passedEventually(cell)) {
      return Math.max(height, GRID_SIZES.timedLaneHeight);
    }
  }
  return height;
}

// Where a lane's label and its badge go, and its panel of variables when
// the lane is expanded. The label's lines are one block centred in the
// folded height, each baseline 11px into its line; the badge is centred on
// the last line; the panel hangs from the badge's bottom edge, the badge
// its tab, and holds a line per variable between its padding; the lane is
// its folded height, or the panel's bottom with air under it.
export interface LabelLayout {
  baselines: number[];
  badgeTop: number;
  panelTop: number;
  panelHeight: number;
  variableBaselines: number[];
  height: number;
}

export function labelLayout(
  row: Pick<GridLaneRow, "top">,
  lane: Pick<GridLane, "cells" | "details" | "variables">,
  expanded: boolean = false
): LabelLayout {
  const folded = foldedLaneHeight(lane);
  const lines = lane.details.length > 0 ? 2 : 1;
  const blockTop = row.top + (folded - lines * GRID_SIZES.labelLineHeight) / 2;
  const baselines = Array.from(
    { length: lines },
    (_line, index) => blockTop + index * GRID_SIZES.labelLineHeight + 11
  );
  const badgeTop = baselines[lines - 1] - 4 - GRID_SIZES.badgeHeight / 2;
  const panelTop = badgeTop + GRID_SIZES.badgeHeight;
  const open = expanded && lane.variables.length > 0;
  const panelHeight = open
    ? 2 * GRID_SIZES.panelPadding +
      lane.variables.length * GRID_SIZES.labelLineHeight
    : 0;
  const variableBaselines = open
    ? lane.variables.map(
        (_variable, index) =>
          panelTop +
          GRID_SIZES.panelPadding +
          index * GRID_SIZES.labelLineHeight +
          11
      )
    : [];
  const height = open
    ? panelTop - row.top + panelHeight + GRID_SIZES.expandedPadding
    : folded;
  return {
    baselines,
    badgeTop,
    panelTop,
    panelHeight,
    variableBaselines,
    height,
  };
}

// How tall this lane is: its folded height, or expanded, the room for its
// panel of variables under the label, the label, the badge and the pills
// staying where they were.
export function laneHeightFor(
  lane: Pick<GridLane, "cells" | "details" | "variables">,
  expanded: boolean = false
): number {
  return labelLayout({ top: 0 }, lane, expanded).height;
}

// The panel's outline as an SVG path: a box with rounded corners but for
// the top-right one, square where the badge's tab joins it.
export function panelPath(
  box: { x: number; y: number; width: number; height: number },
  radius: number
): string {
  const corner = Math.min(radius, box.width / 2, box.height / 2);
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  return [
    `M${box.x + corner},${box.y}`,
    `H${right}`,
    `V${bottom - corner}`,
    `Q${right},${bottom} ${right - corner},${bottom}`,
    `H${box.x + corner}`,
    `Q${box.x},${bottom} ${box.x},${bottom - corner}`,
    `V${box.y + corner}`,
    `Q${box.x},${box.y} ${box.x + corner},${box.y}`,
    "Z",
  ].join(" ");
}

// Where the rows go, from the top of the body: each workflow's section row,
// then its lanes, each as tall as it needs (laneHeightFor), the next
// workflow's section row straight after, since the band is the separation.
export function gridRows(
  groups: readonly GridGroup[],
  expanded: ReadonlySet<string> = new Set()
): GridRows {
  const sections: GridSectionRow[] = [];
  const lanes: GridLaneRow[] = [];
  let top = 0;
  for (const group of groups) {
    sections.push({ group, top });
    top += GRID_SIZES.sectionHeight;
    for (const lane of group.lanes) {
      const height = laneHeightFor(lane, expanded.has(lane.key));
      lanes.push({ group, lane, top, height });
      top += height;
    }
  }
  return { sections, lanes, bottom: top };
}

// How wide a text at the table's size is, before the browser can measure
// it: about 6.4px a character at 12px.
export function estimatedTextWidth(text: string): number {
  return Math.ceil(text.length * 6.4);
}

// How wide the label column is for a widest label line this wide, the
// badge counted in, before the browser can measure the lines: the width
// plus the indent and some air, within reason.
export const LABEL_AIR = 16;
export function estimatedLabelWidth(widestRow: number): number {
  return Math.min(
    380,
    Math.max(220, widestRow + GRID_SIZES.laneIndent + LABEL_AIR)
  );
}
