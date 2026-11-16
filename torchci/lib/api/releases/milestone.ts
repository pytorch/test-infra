import { RELEASE_DATABASE } from "lib/api/releases/database";
import { isoFromClickhouse } from "lib/api/releases/state";
import type { ReleaseMilestoneItems } from "lib/api/releases/types";
import { CollectedMilestoneItemsSchema } from "lib/api/releases/types";
import { queryClickhouse } from "lib/clickhouse";

interface MilestoneDbRow {
  details: string;
  last_checked: string;
}

// Every milestone step from a collector run records the same details object. Read
// the newest one rather than joining the UI to a particular release step.
async function latestMilestoneRow(
  version: string
): Promise<MilestoneDbRow | null> {
  const rows: MilestoneDbRow[] = await queryClickhouse(
    `
SELECT details, toString(observed_at) AS last_checked
FROM ${RELEASE_DATABASE}.release_event
WHERE release = {release: String}
  AND check_type = 'milestone_outstanding_items'
  AND details != ''
ORDER BY observed_at DESC, step_id ASC
LIMIT 1`,
    { release: version },
    "api_release_milestone_items"
  );
  return rows[0] ?? null;
}

export async function getMilestoneItems(
  version: string,
  configuredBranch: string
): Promise<ReleaseMilestoneItems> {
  const row = await latestMilestoneRow(version);
  if (row === null) {
    return {
      version,
      milestone: null,
      branch: configuredBranch,
      branch_cut: null,
      issues: null,
      by_reason: {},
      outstanding: [],
      last_checked: null,
    };
  }

  let collected: unknown;
  try {
    collected = JSON.parse(row.details);
  } catch {
    throw new Error("Release milestone observation has invalid JSON details");
  }
  const parsed = CollectedMilestoneItemsSchema.safeParse(collected);
  if (!parsed.success) {
    throw new Error("Release milestone observation has invalid details");
  }
  return {
    version,
    ...parsed.data,
    last_checked: isoFromClickhouse(row.last_checked),
  };
}
