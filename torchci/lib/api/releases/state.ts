import { RELEASE_DATABASE } from "lib/api/releases/database";
import { queryClickhouse } from "lib/clickhouse";

// The current state of every step of a release: the latest row of release_event for
// each (release, step, RC), read with argMax as the table's comment describes. The
// table is small (a row per step per collector run), so no query here is heavy.

export interface StepStateRow {
  release: string;
  step_id: string;
  rc: string;
  status: string;
  blocking: number | string;
  evidence_text: string;
  evidence_url: string;
  // ClickHouse's DateTime64 text, UTC: 2026-12-01 22:00:00.000
  last_checked: string;
}

const STATE_SELECT = `
SELECT
    release,
    step_id,
    rc,
    argMax(toString(status), observed_at) AS status,
    argMax(blocking, observed_at) AS blocking,
    argMax(evidence_text, observed_at) AS evidence_text,
    argMax(evidence_url, observed_at) AS evidence_url,
    toString(max(observed_at)) AS last_checked
FROM ${RELEASE_DATABASE}.release_event`;

export async function queryStepStates(
  release: string | null
): Promise<StepStateRow[]> {
  return queryClickhouse(
    `${STATE_SELECT}
${release === null ? "" : "WHERE release = {release: String}"}
GROUP BY release, step_id, rc`,
    release === null ? {} : { release },
    "api_release_step_states"
  );
}

// ClickHouse's DateTime64 text as ISO 8601 in UTC.
export function isoFromClickhouse(value: string): string {
  return `${value.replace(" ", "T")}Z`;
}
