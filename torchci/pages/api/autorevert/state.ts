import { queryClickhouseSaved } from "lib/clickhouse";
import type { NextApiRequest, NextApiResponse } from "next";

// In-memory cache (60s TTL)
const cache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL_MS = 60 * 1000;

function getCached(key: string): any | null {
  const entry = cache.get(key);
  if (!entry || Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

interface ParsedState {
  version: number;
  commits: string[];
  commit_times: Record<string, string>;
  columns: any[];
  outcomes: Record<string, any>;
  meta: any;
  advisor_dispatches?: any[];
}

/**
 * Merge multiple autorevert state rows (from different workflow sets)
 * into a unified response.
 */
function mergeStates(
  rows: Array<{
    state: string;
    workflows: string[];
    snapshot_ts?: string;
    ts?: string;
  }>,
  workflowFilter?: string[]
): any {
  // Deduplicate: keep the most recent row per workflow set
  const byWorkflowSet = new Map<string, ParsedState & { ts: string }>();
  for (const row of rows) {
    const key = JSON.stringify([...row.workflows].sort());
    if (!byWorkflowSet.has(key)) {
      try {
        const parsed: ParsedState = JSON.parse(row.state);
        const rowTs = row.snapshot_ts || row.ts || "";
        byWorkflowSet.set(key, { ...parsed, ts: rowTs });
      } catch {
        // Skip malformed state
      }
    }
  }

  if (byWorkflowSet.size === 0) {
    return null;
  }

  // Collect all unique workflows from both the top-level workflows array
  // (monitored workflows) and column data (workflows with active signals).
  // The top-level array includes workflows like "Lint" that may not have
  // active signals but are still monitored.
  const allWorkflows = new Set<string>();
  for (const [setKey, state] of byWorkflowSet.entries()) {
    // Add workflows from the top-level workflows array (stored as the set key)
    try {
      const wfArray = JSON.parse(setKey);
      for (const wf of wfArray) allWorkflows.add(wf);
    } catch {
      // fallback: extract from columns
    }
    for (const col of state.columns || []) {
      if (col.workflow) allWorkflows.add(col.workflow);
    }
  }

  // Merge columns, applying workflow filter
  const columns: any[] = [];
  const outcomes: Record<string, any> = {};
  const advisorDispatches: any[] = [];
  const activeFilter = workflowFilter?.length ? new Set(workflowFilter) : null;

  for (const state of byWorkflowSet.values()) {
    for (const col of state.columns || []) {
      if (activeFilter && !activeFilter.has(col.workflow)) continue;
      columns.push(col);
    }
    for (const [key, outcome] of Object.entries(state.outcomes || {})) {
      // Apply workflow filter to outcomes
      const wf = key.split(":")[0];
      if (activeFilter && !activeFilter.has(wf)) continue;
      outcomes[key] = outcome;
    }
    for (const dispatch of state.advisor_dispatches || []) {
      advisorDispatches.push(dispatch);
    }
  }

  // Sort columns: revert first, then restart, then ineligible, then by key
  const outcomePriority: Record<string, number> = {
    revert: 0,
    restart: 1,
    ineligible: 2,
  };
  columns.sort((a, b) => {
    const pa = outcomePriority[a.outcome] ?? 3;
    const pb = outcomePriority[b.outcome] ?? 3;
    if (pa !== pb) return pa - pb;
    if (a.workflow !== b.workflow) return a.workflow.localeCompare(b.workflow);
    return a.key.localeCompare(b.key);
  });

  // Build commit list from state, trimming from the bottom
  // (oldest commits with no events in any column are removed,
  // but middle gaps are preserved — those may have pending events)
  // Normalize commit timestamps to include Z suffix (CH omits it)
  const commitTimes: Record<string, string> = {};
  const commitOrder: string[] = [];
  const commitOrderSet = new Set<string>();
  for (const state of byWorkflowSet.values()) {
    for (const [sha, ts] of Object.entries(state.commit_times || {})) {
      commitTimes[sha] = ts && !ts.endsWith("Z") ? ts + "Z" : ts;
    }
    for (const sha of state.commits || []) {
      if (!commitOrderSet.has(sha)) {
        commitOrderSet.add(sha);
        commitOrder.push(sha);
      }
    }
  }
  // Sort by timestamp desc (newest first) — timestamps already normalized with Z
  commitOrder.sort(
    (a, b) =>
      new Date(commitTimes[b] || "1970-01-01Z").getTime() -
      new Date(commitTimes[a] || "1970-01-01Z").getTime()
  );
  // Find which commits have events in the filtered columns
  const commitsWithEvents = new Set<string>();
  for (const col of columns) {
    for (const sha of Object.keys(col.cells || {})) {
      if ((col.cells[sha] || []).length > 0) {
        commitsWithEvents.add(sha);
      }
    }
  }
  // Trim from the bottom: find the last (oldest) commit with events
  let lastEventIdx = commitOrder.length - 1;
  while (lastEventIdx >= 0 && !commitsWithEvents.has(commitOrder[lastEventIdx])) {
    lastEventIdx--;
  }
  const allCommits = commitOrder.slice(0, lastEventIdx + 1);

  // Get the most recent timestamp
  let latestTs = "";
  for (const state of byWorkflowSet.values()) {
    if (state.ts > latestTs) latestTs = state.ts;
  }

  // Get lookback hours from first state
  const firstState = byWorkflowSet.values().next().value;

  return {
    ts: latestTs,
    commits: allCommits,
    commitTimes,
    columns,
    outcomes,
    advisorDispatches,
    availableWorkflows: Array.from(allWorkflows).sort(),
    meta: {
      lookbackHours: firstState?.meta?.lookback_hours ?? 16,
      repo: firstState?.meta?.repo ?? "pytorch/pytorch",
    },
  };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const ts =
    (req.query.ts as string) || new Date().toISOString().replace("T", " ");
  const workflows = req.query.workflows
    ? JSON.parse(req.query.workflows as string)
    : undefined;
  const repo = (req.query.repo as string) || "pytorch/pytorch";

  const cacheKey = `state:${repo}:${ts}:${JSON.stringify(workflows || [])}`;
  const cached = getCached(cacheKey);
  if (cached) {
    res.setHeader(
      "Cache-Control",
      "s-maxage=30, stale-while-revalidate=120"
    );
    return res.status(200).json(cached);
  }

  try {
    const rows = await queryClickhouseSaved("autorevert_state_for_ts", {
      repo,
      target_ts: ts.replace("T", " ").replace("Z", ""),
    });

    const merged = mergeStates(
      rows as Array<{ state: string; workflows: string[]; ts: string }>,
      workflows
    );

    if (!merged) {
      return res
        .status(404)
        .json({ error: "No autorevert state found near this timestamp" });
    }

    cache.set(cacheKey, { data: merged, ts: Date.now() });

    res.setHeader(
      "Cache-Control",
      "s-maxage=30, stale-while-revalidate=120"
    );
    return res.status(200).json(merged);
  } catch (error: any) {
    console.error("Error fetching autorevert state:", error);
    return res.status(500).json({ error: error.message });
  }
}
