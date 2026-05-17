import { verifyFpForPr } from "lib/autorevert/fpVerification";
import {
  foldKillswitchWindows,
  KillswitchLabelEvent,
  killswitchWindowAt,
} from "lib/autorevert/killswitchWindows";
import { queryClickhouseSaved } from "lib/clickhouse";
import { getOctokit } from "lib/github";
import type { NextApiRequest, NextApiResponse } from "next";

// Simple in-memory cache with TTL
interface CacheEntry {
  data: any;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCached(key: string): any | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: any): void {
  cache.set(key, { data, timestamp: Date.now() });
}

// Types
interface SignificantRevert {
  recovery_sha: string;
  recovery_time: string;
  recovery_message: string;
  signal_keys: string[];
  signals_fixed: number;
  max_red_streak_length: number;
  reverted_commit_sha: string;
  reverted_pr_numbers: string[];
  is_autorevert: boolean;
  recovery_type: string;
}

interface AutorevertEvent {
  reverted_sha: string;
  autorevert_time: string;
  workflows: string[];
  source_signal_keys: string[];
  pr_number: string;
  reverted_message_snippet: string;
  revert_sha: string | null;
  revert_time: string | null;
  revert_message_snippet: string | null;
}

interface FalsePositiveCandidate {
  reverted_sha: string;
  autorevert_time: string;
  pr_number: string;
  revert_sha: string | null;
  revert_time: string | null;
  workflows: string[];
  source_signal_keys: string[];
}

interface VerifiedFalsePositive extends FalsePositiveCandidate {
  pr_state: string;
  pr_merged: boolean;
  commits_after_revert: number;
  verification_status: "confirmed_fp" | "legit_revert" | "unknown";
  verification_reason: string;
}

interface WeeklyMetric {
  week: string;
  total_revert_recoveries: number;
  autorevert_recoveries: number;
  human_revert_recoveries: number;
  total_signal_recoveries: number;
  non_revert_recoveries: number;
  autorevert_rate: number;
  human_revert_rate: number;
  // New metrics
  false_positives: number;
  false_negatives_killswitch: number;
  precision: number;
  recall: number;
}

async function verifyFalsePositive(
  octokit: any,
  candidate: FalsePositiveCandidate
): Promise<VerifiedFalsePositive> {
  const prNumber = parseInt(candidate.pr_number);
  const revertTime = new Date(candidate.autorevert_time);
  const result = await verifyFpForPr(octokit, prNumber, revertTime);
  return { ...candidate, ...result };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    startTime,
    stopTime,
    workflowNames,
    minRedCommits = "2",
    minGreenCommits = "2",
  } = req.query;

  if (!startTime || !stopTime || !workflowNames) {
    return res.status(400).json({
      error: "startTime, stopTime, and workflowNames are required",
    });
  }

  // Parse workflowNames from JSON string
  let workflows: string[];
  try {
    workflows = JSON.parse(workflowNames as string);
  } catch {
    return res
      .status(400)
      .json({ error: "workflowNames must be valid JSON array" });
  }

  // Create cache key from parameters
  const cacheKey = `metrics-${startTime}-${stopTime}-${JSON.stringify(
    workflows
  )}-${minRedCommits}-${minGreenCommits}`;

  // Check cache first
  const cached = getCached(cacheKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  try {
    const queryParams = {
      startTime: startTime as string,
      stopTime: stopTime as string,
      workflowNames: workflows,
      minRedCommits: parseInt(minRedCommits as string),
      minGreenCommits: parseInt(minGreenCommits as string),
    };

    // Run queries in parallel
    const [
      significantReverts,
      autorevertEvents,
      weeklyMetricsRaw,
      killswitchEvents,
    ] = await Promise.all([
      queryClickhouseSaved(
        "autorevert_significant_reverts",
        queryParams
      ) as Promise<SignificantRevert[]>,
      queryClickhouseSaved(
        "autorevert_events_with_commits",
        queryParams
      ) as Promise<AutorevertEvent[]>,
      queryClickhouseSaved("autorevert_weekly_metrics", queryParams) as Promise<
        any[]
      >,
      queryClickhouseSaved("autorevert_killswitch_windows", {
        stopTime: queryParams.stopTime,
      }) as Promise<KillswitchLabelEvent[]>,
    ]);
    const killswitchWindows = foldKillswitchWindows(killswitchEvents);

    // Build set of recovery SHAs (reverts that fixed signals)
    const recoveryShaSet = new Set(
      significantReverts.map((r) => r.recovery_sha)
    );

    // Classify autorevert events
    const truePositives: AutorevertEvent[] = [];
    const falsePositiveCandidates: FalsePositiveCandidate[] = [];

    for (const event of autorevertEvents) {
      if (event.revert_sha && recoveryShaSet.has(event.revert_sha)) {
        // Autorevert's revert commit has signal recovery - True Positive
        truePositives.push(event);
      } else {
        // No signal recovery found - False Positive Candidate
        falsePositiveCandidates.push({
          reverted_sha: event.reverted_sha,
          autorevert_time: event.autorevert_time,
          pr_number: event.pr_number,
          revert_sha: event.revert_sha,
          revert_time: event.revert_time,
          workflows: event.workflows,
          source_signal_keys: event.source_signal_keys,
        });
      }
    }

    // Count False Negatives: human reverts with signal recovery. Partition
    // out the ones where the autorevert killswitch was active at recovery
    // time — those are not a lambda miss; they're an upstream_infra class
    // (`ci: disable-autorevert` label on an open issue, see
    // `default.issues_label_event`). Killswitch FNs are surfaced as a
    // third category and excluded from the recall denominator.
    const allFalseNegatives = significantReverts.filter(
      (r) => !r.is_autorevert && r.recovery_type === "human_revert_recovery"
    );
    const falseNegatives: SignificantRevert[] = [];
    const falseNegativesKillswitch: Array<
      SignificantRevert & { killswitch_issue: number }
    > = [];
    for (const r of allFalseNegatives) {
      const w = killswitchWindowAt(killswitchWindows, r.recovery_time);
      if (w) {
        falseNegativesKillswitch.push({
          ...r,
          killswitch_issue: w.issue_number,
        });
      } else {
        falseNegatives.push(r);
      }
    }

    // Verify false positive candidates via GitHub API
    let verifiedFPs: VerifiedFalsePositive[] = [];
    if (falsePositiveCandidates.length > 0) {
      const octokit = await getOctokit("pytorch", "pytorch");

      for (const candidate of falsePositiveCandidates) {
        // Check per-PR cache
        const prCacheKey = `pr-verify-${candidate.pr_number}-${candidate.autorevert_time}`;
        const cachedVerification = getCached(prCacheKey);

        if (cachedVerification) {
          verifiedFPs.push(cachedVerification);
        } else {
          const verified = await verifyFalsePositive(octokit, candidate);
          setCache(prCacheKey, verified);
          verifiedFPs.push(verified);
        }
      }
    }

    // Separate confirmed FPs from legit reverts
    const confirmedFPs = verifiedFPs.filter(
      (v) => v.verification_status === "confirmed_fp"
    );
    const legitReverts = verifiedFPs.filter(
      (v) => v.verification_status === "legit_revert"
    );

    // Calculate overall precision/recall
    // TP = autoreverts with signal recovery + autoreverts without signal recovery but verified as legit
    // (legit reverts without signal recovery are still valid autoreverts, just didn't fix our tracked signals)
    const tpWithSignalRecovery = truePositives.length;
    const tpWithoutSignalRecovery = legitReverts.length;
    const tp = tpWithSignalRecovery + tpWithoutSignalRecovery;
    const fp = confirmedFPs.length;
    const fn = falseNegatives.length;

    const precision = tp + fp > 0 ? (tp / (tp + fp)) * 100 : 100;
    const recall = tp + fn > 0 ? (tp / (tp + fn)) * 100 : 100;

    // Enhance weekly metrics with precision/recall.
    // Group FPs and killswitch-FNs by week for the weekly aggregation.
    const fpByWeek = new Map<string, number>();
    for (const fp of confirmedFPs) {
      const week = getWeekStart(new Date(fp.autorevert_time));
      fpByWeek.set(week, (fpByWeek.get(week) || 0) + 1);
    }
    const fnKsByWeek = new Map<string, number>();
    for (const r of falseNegativesKillswitch) {
      const week = getWeekStart(new Date(r.recovery_time));
      fnKsByWeek.set(week, (fnKsByWeek.get(week) || 0) + 1);
    }

    const weeklyMetrics: WeeklyMetric[] = weeklyMetricsRaw.map((w) => {
      const weekFPs = fpByWeek.get(w.week) || 0;
      const weekFNKs = fnKsByWeek.get(w.week) || 0;
      const weekTP = w.autorevert_recoveries;
      // human_revert_recoveries from the saved query counts all human
      // reverts with signal recovery; subtract the killswitch-attributed
      // ones so weekly recall matches the overall recall semantics.
      const weekFN = Math.max(0, w.human_revert_recoveries - weekFNKs);

      return {
        ...w,
        false_positives: weekFPs,
        false_negatives_killswitch: weekFNKs,
        precision:
          weekTP + weekFPs > 0
            ? Math.round((weekTP / (weekTP + weekFPs)) * 1000) / 10
            : 100,
        recall:
          weekTP + weekFN > 0
            ? Math.round((weekTP / (weekTP + weekFN)) * 1000) / 10
            : 100,
      };
    });

    const result = {
      summary: {
        // Counts
        total_autoreverts: autorevertEvents.length,
        true_positives: tp,
        tp_with_signal_recovery: tpWithSignalRecovery,
        tp_without_signal_recovery: tpWithoutSignalRecovery,
        confirmed_false_positives: fp,
        false_negatives: fn,
        false_negatives_killswitch: falseNegativesKillswitch.length,
        // Rates
        precision: Math.round(precision * 10) / 10,
        recall: Math.round(recall * 10) / 10,
        // For weekly metrics aggregation
        total_revert_recoveries: significantReverts.filter(
          (r) => r.recovery_type !== "non_revert_recovery"
        ).length,
      },
      weeklyMetrics,
      significantReverts,
      killswitchWindows,
      falsePositives: {
        candidates_checked: falsePositiveCandidates.length,
        confirmed: confirmedFPs,
        legit_reverts: legitReverts,
        unknown: verifiedFPs.filter((v) => v.verification_status === "unknown"),
      },
      falseNegatives: falseNegatives.map((r) => ({
        recovery_sha: r.recovery_sha,
        recovery_time: r.recovery_time,
        signals_fixed: r.signals_fixed,
        reverted_pr_numbers: r.reverted_pr_numbers,
      })),
      falseNegativesKillswitch: falseNegativesKillswitch.map((r) => ({
        recovery_sha: r.recovery_sha,
        recovery_time: r.recovery_time,
        signals_fixed: r.signals_fixed,
        reverted_pr_numbers: r.reverted_pr_numbers,
        killswitch_issue: r.killswitch_issue,
      })),
    };

    setCache(cacheKey, result);
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("Error fetching autorevert metrics:", error);
    return res.status(500).json({ error: error.message });
  }
}

function getWeekStart(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Monday start
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().split("T")[0];
}
