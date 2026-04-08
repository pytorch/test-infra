/**
 * Types for the Autorevert Signal Grid view.
 *
 * The autorevert state is stored as JSON blobs in misc.autorevert_state.
 * The API merges multiple workflow-set rows into a unified response.
 */

// --- API Response ---

export interface AutorevertStateResponse {
  ts: string; // actual snapshot timestamp
  commits: string[]; // SHA list, newest first
  commitTimes: Record<string, string>; // sha → ISO8601
  columns: SignalColumn[];
  outcomes: Record<string, Outcome>; // "workflow:key" → outcome
  advisorDispatches: AdvisorDispatch[];
  availableWorkflows: string[]; // for filter UI
  meta: {
    lookbackHours: number;
    repo: string;
  };
}

// --- Signal Column ---

export interface SignalColumn {
  workflow: string;
  key: string;
  outcome: "revert" | "restart" | "ineligible";
  cells: Record<string, CellEvent[]>; // sha → events
  jobBaseName?: string;
  ineligible?: { reason: string; message: string };
  advisorResults?: Record<string, ColumnAdvisorResult>; // sha → result
}

export interface CellEvent {
  status: "success" | "failure" | "pending";
  started_at: string;
  name: string;
  ended_at?: string;
  job_id?: number;
  run_attempt?: number;
}

export interface ColumnAdvisorResult {
  verdict: "revert" | "not_related" | "garbage" | "unsure";
  confidence: number;
  signal_key: string;
}

// --- Outcomes ---

export type Outcome =
  | { type: "AutorevertPattern"; data: AutorevertPatternData }
  | { type: "RestartCommits"; data: RestartData }
  | { type: "Ineligible"; data: IneligibleData };

export interface AutorevertPatternData {
  workflow_name: string;
  suspected_commit: string;
  older_successful_commit: string;
  newer_failing_commits: string[];
  wf_run_id?: number;
  job_id?: number;
  advisor_verdict?: {
    verdict: string;
    confidence: number;
  };
}

export interface RestartData {
  commit_shas: string[];
}

export interface IneligibleData {
  reason: string;
  message: string;
}

// --- Advisor ---

export interface AdvisorDispatch {
  signal_key: string;
  commit_sha: string;
  workflow_name: string;
  mode: "run" | "log";
}

// --- Cell Highlight ---

export type CellHighlight =
  | "suspected"
  | "baseline"
  | "newer-fail"
  | "restart";

/**
 * Parse run_id from event name format:
 * "wf=<workflow> kind=<kind> id=<signal_id> run=<run_id> attempt=<attempt>"
 */
export function parseRunId(eventName: string): number | null {
  const match = eventName.match(/run=(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Build GitHub Actions URL for an event.
 */
export function eventUrl(
  repo: string,
  event: CellEvent
): string | null {
  const runId = parseRunId(event.name);
  if (!runId) return null;
  if (event.job_id) {
    return `https://github.com/${repo}/actions/runs/${runId}/job/${event.job_id}`;
  }
  return `https://github.com/${repo}/actions/runs/${runId}`;
}

/**
 * Compute cell highlights from an outcome.
 */
export function getHighlightsForOutcome(
  outcome: Outcome | undefined
): Map<string, CellHighlight> {
  const highlights = new Map<string, CellHighlight>();
  if (!outcome) return highlights;

  if (outcome.type === "AutorevertPattern") {
    const data = outcome.data;
    highlights.set(data.suspected_commit, "suspected");
    highlights.set(data.older_successful_commit, "baseline");
    for (const sha of data.newer_failing_commits) {
      highlights.set(sha, "newer-fail");
    }
  } else if (outcome.type === "RestartCommits") {
    for (const sha of outcome.data.commit_shas) {
      highlights.set(sha, "restart");
    }
  }
  return highlights;
}
