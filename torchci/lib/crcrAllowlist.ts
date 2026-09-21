import yaml from "js-yaml";
import { Octokit } from "octokit";

// Mirror of the Python AllowlistLevel enum in aws/lambda/cross_repo_ci_relay/utils/allowlist.py
export type AllowlistLevel = "L1" | "L2" | "L3" | "L4";
export type CrcrEvent = "pull_request" | "nightly";

const DEFAULT_CRCR_EVENTS: CrcrEvent[] = ["pull_request", "nightly"];
const CRCR_EVENTS = new Set<CrcrEvent>(DEFAULT_CRCR_EVENTS);

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
  events: CrcrEvent[];
}

function parseOncalls(rawOncalls: unknown, context: string): string[] {
  if (rawOncalls === undefined || rawOncalls === null) return [];
  if (typeof rawOncalls === "string") {
    return rawOncalls
      .split(",")
      .map((oncall) => oncall.trim())
      .filter(Boolean);
  }
  if (Array.isArray(rawOncalls)) {
    return rawOncalls.map((oncall) => String(oncall).trim()).filter(Boolean);
  }
  throw new Error(
    `Invalid allowlist: ${context}.oncalls must be a string or list`
  );
}

function parseEvents(rawEvents: unknown, context: string): CrcrEvent[] {
  if (rawEvents === undefined || rawEvents === null) {
    return [...DEFAULT_CRCR_EVENTS];
  }
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    throw new Error(
      `Invalid allowlist: ${context}.events must be a non-empty list`
    );
  }

  const events: CrcrEvent[] = [];
  for (const rawEvent of rawEvents) {
    if (typeof rawEvent !== "string") {
      throw new Error(
        `Invalid allowlist: ${context}.events entries must be strings`
      );
    }
    const event = rawEvent.trim() as CrcrEvent;
    if (!CRCR_EVENTS.has(event)) {
      throw new Error(
        `Invalid allowlist: ${context}.events has unsupported event ${rawEvent}`
      );
    }
    if (events.includes(event)) {
      throw new Error(
        `Invalid allowlist: ${context}.events contains duplicate ${event}`
      );
    }
    events.push(event);
  }
  return events;
}

function parseMetadata(
  rawMetadata: unknown,
  context: string
): Pick<CrcrRepoEntry, "oncalls" | "events"> {
  if (
    typeof rawMetadata === "object" &&
    rawMetadata !== null &&
    !Array.isArray(rawMetadata)
  ) {
    const metadata = rawMetadata as Record<string, unknown>;
    const unknownFields = Object.keys(metadata).filter(
      (key) => key !== "oncalls" && key !== "events"
    );
    if (unknownFields.length > 0) {
      throw new Error(
        `Invalid allowlist: ${context} has unsupported metadata field(s): ${unknownFields.join(", ")}`
      );
    }
    return {
      oncalls: parseOncalls(metadata.oncalls, context),
      events: parseEvents(metadata.events, context),
    };
  }
  return {
    oncalls: parseOncalls(rawMetadata, context),
    events: [...DEFAULT_CRCR_EVENTS],
  };
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
 *
 * Entries may specify `events: [pull_request, nightly]`; omitted events retain
 * the legacy behavior of participating in both.
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

  getEventsForRepo(repo: string): CrcrEvent[] {
    return this.repoMap.get(repo.toLowerCase())?.events ?? [];
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
          for (const [repoRaw, metadataRaw] of Object.entries(repoMap)) {
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

            const metadata = parseMetadata(
              metadataRaw,
              `L3.${trimmedDevice}.${repo}`
            );
            entries.push({
              repo,
              level,
              device: trimmedDevice,
              ...metadata,
            });
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
        for (const [idx, rawEntry] of (
          rawEntries as unknown[]
        ).entries()) {
          let repo: string;
          let metadata: Pick<CrcrRepoEntry, "oncalls" | "events">;

          if (typeof rawEntry === "string") {
            repo = rawEntry.trim();
            metadata = {
              oncalls: [],
              events: [...DEFAULT_CRCR_EVENTS],
            };
          } else if (typeof rawEntry === "object" && rawEntry !== null) {
            const keys = Object.keys(rawEntry);
            if (keys.length !== 1) {
              throw new Error(
                `Invalid allowlist: ${level} entry must be a string or single-key mapping`
              );
            }
            repo = keys[0].trim();
            metadata = parseMetadata(
              (rawEntry as Record<string, unknown>)[keys[0]],
              `${level}[${idx}]`
            );
          } else {
            continue;
          }

          if (seenRepos.has(repo.toLowerCase())) {
            throw new Error(`Invalid allowlist: duplicate repo ${repo}`);
          }
          seenRepos.add(repo.toLowerCase());
          entries.push({ repo, level, device: "", ...metadata });
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
