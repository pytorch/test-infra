import { verifyFpForPr } from "lib/autorevert/fpVerification";
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

interface FalsePositiveCandidate {
  original_pr: string;
  reverted_sha: string;
  revert_time: string;
  original_message_snippet: string;
  reland_sha: string;
  reland_time: string;
  reland_message_snippet: string;
  hours_to_reland: number;
  status: string;
}

interface VerifiedFalsePositive extends FalsePositiveCandidate {
  pr_state: string;
  pr_merged: boolean;
  commits_after_revert: number;
  verification_status: "confirmed_fp" | "legit_revert" | "unknown";
  verification_reason: string;
}

async function verifyFalsePositive(
  octokit: any,
  candidate: FalsePositiveCandidate
): Promise<VerifiedFalsePositive> {
  const prNumber = parseInt(candidate.original_pr);
  const revertTime = new Date(candidate.revert_time);
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

  const { startTime, stopTime } = req.query;

  if (!startTime || !stopTime) {
    return res
      .status(400)
      .json({ error: "startTime and stopTime are required" });
  }

  // Create cache key from parameters
  const cacheKey = `fp-${startTime}-${stopTime}`;

  // Check cache first
  const cached = getCached(cacheKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  try {
    // Fetch candidates from ClickHouse
    const candidates: FalsePositiveCandidate[] = await queryClickhouseSaved(
      "autorevert_false_positives",
      {
        startTime: startTime as string,
        stopTime: stopTime as string,
      }
    );

    if (candidates.length === 0) {
      const result = { candidates: [], verified: [] };
      setCache(cacheKey, result);
      return res.status(200).json(result);
    }

    // Get Octokit instance
    const octokit = await getOctokit("pytorch", "pytorch");

    // Verify each candidate (with rate limiting consideration)
    const verified: VerifiedFalsePositive[] = [];
    for (const candidate of candidates) {
      // Check per-PR cache
      const prCacheKey = `pr-${candidate.original_pr}-${candidate.revert_time}`;
      const cachedVerification = getCached(prCacheKey);

      if (cachedVerification) {
        verified.push(cachedVerification);
      } else {
        const verifiedCandidate = await verifyFalsePositive(octokit, candidate);
        setCache(prCacheKey, verifiedCandidate);
        verified.push(verifiedCandidate);
      }
    }

    // Separate confirmed false positives from legit reverts
    const confirmedFPs = verified.filter(
      (v) => v.verification_status === "confirmed_fp"
    );
    const legitReverts = verified.filter(
      (v) => v.verification_status === "legit_revert"
    );
    const unknown = verified.filter((v) => v.verification_status === "unknown");

    const result = {
      summary: {
        total_candidates: candidates.length,
        confirmed_false_positives: confirmedFPs.length,
        legit_reverts: legitReverts.length,
        unknown: unknown.length,
      },
      confirmed_false_positives: confirmedFPs,
      legit_reverts: legitReverts,
      unknown: unknown,
    };

    setCache(cacheKey, result);
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("Error fetching false positives:", error);
    return res.status(500).json({ error: error.message });
  }
}
