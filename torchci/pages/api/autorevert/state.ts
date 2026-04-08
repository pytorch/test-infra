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
  rows: Array<{ state: string; workflows: string[]; ts: string }>,
  workflowFilter?: string[]
): any {
  // Deduplicate: keep the most recent row per workflow set
  const byWorkflowSet = new Map<string, ParsedState & { ts: string }>();
  for (const row of rows) {
    const key = JSON.stringify(row.workflows.sort());
    if (!byWorkflowSet.has(key)) {
      try {
        const parsed: ParsedState = JSON.parse(row.state);
        byWorkflowSet.set(key, { ...parsed, ts: row.ts });
      } catch {
        // Skip malformed state
      }
    }
  }

  if (byWorkflowSet.size === 0) {
    return null;
  }

  // Collect all unique workflows across all states
  const allWorkflows = new Set<string>();
  for (const state of byWorkflowSet.values()) {
    for (const col of state.columns || []) {
      if (col.workflow) allWorkflows.add(col.workflow);
    }
  }

  // Merge commits (union, deduplicated, sorted by timestamp desc)
  const commitTimes: Record<string, string> = {};
  for (const state of byWorkflowSet.values()) {
    Object.assign(commitTimes, state.commit_times || {});
  }
  const allCommits = Object.keys(commitTimes).sort(
    (a, b) =>
      new Date(commitTimes[b]).getTime() - new Date(commitTimes[a]).getTime()
  );

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
      ts: ts.replace("T", " ").replace("Z", ""),
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
