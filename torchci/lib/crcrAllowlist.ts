import yaml from "js-yaml";
import { Octokit } from "octokit";

// Mirror of the Python AllowlistLevel enum in aws/lambda/cross_repo_ci_relay/utils/allowlist.py
export type AllowlistLevel = "L1" | "L2" | "L3" | "L4";

const LEVEL_ORDER: Record<AllowlistLevel, number> = {
  L1: 0,
  L2: 1,
  L3: 2,
  L4: 3,
};

export interface CrcrRepoEntry {
  repo: string;
  level: AllowlistLevel;
  device: string; // L3 only: suffix of ciflow/crcr/{device} label
  oncalls: string[];
}

/**
 * Parsed and indexed CRCR allowlist.
 *
 * The source YAML format (from .github/allowlist.yml):
 *   L1:
 *     - org1/repo1
 *   L2:
 *     - org2/repo2
 *   L3:
 *     device1:
 *       org3/device1-repo: [oncall1, oncall2]
 *   L4:
 *     - org5/repo5: oncall1, oncall2
 */
export class CrcrAllowlist {
  private repoMap: Map<string, CrcrRepoEntry>;

  constructor(entries: CrcrRepoEntry[]) {
    this.repoMap = new Map();
    for (const entry of entries) {
      this.repoMap.set(entry.repo.toLowerCase(), entry);
    }
  }

  getLevelForRepo(repo: string): AllowlistLevel | null {
    const entry = this.repoMap.get(repo.toLowerCase());
    return entry?.level ?? null;
  }

  getOncallsForRepo(repo: string): string[] {
    const entry = this.repoMap.get(repo.toLowerCase());
    return entry?.oncalls ?? [];
  }

  getDeviceForRepo(repo: string): string | null {
    const entry = this.repoMap.get(repo.toLowerCase());
    return entry?.device || null;
  }

  /** True when a failed check run for this repo should block PR merge (L4 only). */
  isBlocking(repo: string): boolean {
    const level = this.getLevelForRepo(repo);
    return level !== null && LEVEL_ORDER[level] >= LEVEL_ORDER.L4;
  }

  /** Return all entries in the allowlist. */
  getEntries(): CrcrRepoEntry[] {
    return Array.from(this.repoMap.values());
  }

  /** Return repos at or above the given level (inclusive). */
  getReposAtOrAboveLevel(level: AllowlistLevel): string[] {
    const min = LEVEL_ORDER[level];
    const repos: string[] = [];
    for (const [, entry] of this.repoMap) {
      if (LEVEL_ORDER[entry.level] >= min) {
        repos.push(entry.repo);
      }
    }
    return repos;
  }

  /** Parse raw YAML into a CrcrAllowlist. Throws on invalid format. */
  static fromYaml(yamlStr: string): CrcrAllowlist {
    const raw = yaml.load(yamlStr) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") {
      throw new Error("Invalid allowlist: root must be a mapping");
    }

    const entries: CrcrRepoEntry[] = [];
    const seenRepos = new Set<string>();

    for (const level of ["L1", "L2", "L3", "L4"] as AllowlistLevel[]) {
      if (level === "L3") {
        const l3Raw = raw[level];
        // L3 is a device mapping: { device: { repo: [oncalls] } }
        if (l3Raw === undefined || l3Raw === null) continue;
        if (typeof l3Raw !== "object" || Array.isArray(l3Raw)) {
          throw new Error(
            `Invalid allowlist: L3 must be a device mapping, got ${
              Array.isArray(l3Raw) ? "list" : typeof l3Raw
            }`
          );
        }
        const devices = l3Raw as Record<string, unknown>;
        for (const [device, reposRaw] of Object.entries(devices)) {
          const trimmedDevice = String(device).trim();
          if (!trimmedDevice) {
            throw new Error(
              "Invalid allowlist: L3 device name must not be empty"
            );
          }
          if (
            !reposRaw ||
            typeof reposRaw !== "object" ||
            Array.isArray(reposRaw)
          ) {
            throw new Error(
              `Invalid allowlist: L3.${trimmedDevice} must be a repo mapping`
            );
          }
          const repoMap = reposRaw as Record<string, unknown>;
          for (const [repoRaw, oncallsRaw] of Object.entries(repoMap)) {
            const repo = String(repoRaw)
              .trim()
              .replace(/^\/|\/$/g, "");
            if (!repo || !repo.includes("/")) {
              throw new Error(
                `Invalid allowlist: L3.${trimmedDevice}.${repoRaw} must be in owner/repo format`
              );
            }
            if (seenRepos.has(repo.toLowerCase())) {
              throw new Error(`Invalid allowlist: duplicate repo ${repo}`);
            }
            seenRepos.add(repo.toLowerCase());

            const oncalls: string[] = [];
            if (Array.isArray(oncallsRaw)) {
              for (const o of oncallsRaw) {
                const trimmed = String(o).trim();
                if (trimmed) oncalls.push(trimmed);
              }
            }
            entries.push({ repo, level, device: trimmedDevice, oncalls });
          }
        }
      } else {
        const rawEntries = raw[level];
        if (rawEntries === undefined || rawEntries === null) continue;
        if (!Array.isArray(rawEntries)) {
          throw new Error(
            `Invalid allowlist: ${level} must be a list, got ${typeof rawEntries}`
          );
        }
        for (const rawEntry of rawEntries as unknown[]) {
          let repo: string;
          let oncalls: string[] = [];

          if (typeof rawEntry === "string") {
            repo = rawEntry.trim();
          } else if (typeof rawEntry === "object" && rawEntry !== null) {
            const keys = Object.keys(rawEntry);
            if (keys.length !== 1) {
              throw new Error(
                `Invalid allowlist: ${level} entry must be a string or single-key mapping`
              );
            }
            repo = keys[0].trim();
            const rawOncalls = (rawEntry as Record<string, unknown>)[keys[0]];
            if (typeof rawOncalls === "string") {
              oncalls = rawOncalls
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            } else if (Array.isArray(rawOncalls)) {
              oncalls = (rawOncalls as unknown[])
                .map((s) => String(s).trim())
                .filter(Boolean);
            }
          } else {
            continue;
          }

          if (seenRepos.has(repo.toLowerCase())) {
            throw new Error(`Invalid allowlist: duplicate repo ${repo}`);
          }
          seenRepos.add(repo.toLowerCase());
          entries.push({ repo, level, device: "", oncalls });
        }
      }
    }

    return new CrcrAllowlist(entries);
  }
}

/** TTL for the in-memory allowlist cache, in milliseconds.  Default 15 minutes. */
export const CRCR_ALLOWLIST_CACHE_TTL_MS = 15 * 60 * 1000;

// In-memory cache
let cachedAllowlist: { allowlist: CrcrAllowlist; ts: number } | null = null;

/**
 * Fetch and parse the CRCR allowlist from a GitHub repository.
 *
 * Uses an in-memory cache with a 15-minute TTL (matching the Redis TTL floor
 * in the Python lambda).
 */
export async function fetchCrcrAllowlist(
  octokit: Octokit,
  owner: string = "pytorch",
  repo: string = "pytorch",
  path: string = ".github/allowlist.yml",
  ref: string = "main"
): Promise<CrcrAllowlist> {
  if (
    cachedAllowlist &&
    Date.now() - cachedAllowlist.ts < CRCR_ALLOWLIST_CACHE_TTL_MS
  ) {
    return cachedAllowlist.allowlist;
  }

  const response = await octokit.rest.repos.getContent({
    owner,
    repo,
    path,
    ref,
  });

  if (!("content" in response.data)) {
    throw new Error("Failed to fetch allowlist: unexpected response format");
  }

  const yamlStr = Buffer.from(response.data.content, "base64").toString(
    "utf-8"
  );
  const allowlist = CrcrAllowlist.fromYaml(yamlStr);
  cachedAllowlist = { allowlist, ts: Date.now() };
  return allowlist;
}

/** Clear the in-memory cache (useful for testing). */
export function clearAllowlistCache(): void {
  cachedAllowlist = null;
}
