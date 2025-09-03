// Shared utilities for GitHub runners functionality

// Types
export interface RunnerData {
  id: number;
  name: string;
  os: string;
  status: "online" | "offline";
  busy: boolean;
  labels: Array<{
    id?: number;
    name: string;
    type: "read-only" | "custom";
  }>;
}

export interface RunnerGroup {
  label: string;
  totalCount: number;
  idleCount: number;
  busyCount: number;
  offlineCount: number;
  runners: RunnerData[];
}

export interface RunnersApiResponse {
  groups: RunnerGroup[];
  totalRunners: number;
}

// Utility functions
export function getRunnerGroupLabel(runner: RunnerData): string {
  const labelNames = runner.labels.map((label) => label.name);

  // Find labels with "." (excluding any that end with ".runners") or starting with "macos-"
  // Why have such funky logic? We have many labels on our runners today, but this
  // is what's common in all the ones that jobs actually use.
  const validLabels = labelNames.filter(
    (name) =>
      (name.includes(".") && !name.endsWith(".runners")) || // "*.runners" is added to autoscaled runners
      name.startsWith("macos-")
  );

  if (validLabels.length > 0) {
    // Handle synonyms. Today these are used by macOS runners which have two
    // labels that runners could potentially use instead of just one.
    // The synonymous labels tend to look like "macos-m1-14" and "macos-m1-stable"
    // If we end up in this situation, assume all valid labels are valid synonyms
    // and treat them as such.
    return validLabels.join(" / ");
  }

  // Fallback: Parse runner name for grouping info
  // Special case for ROCm runners provided by that don't have proper GitHub labels
  // but use naming conventions like: linux.rocm.gpu.gfx942.1-xxxx-runner-xxxxx
  const runnerName = runner.name;

  // Look for dotted prefixes before "-" followed by random suffix
  const namePatterns = [
    /^([a-z]+\.[a-z0-9.]+)-[a-z0-9]+/i, // linux.rocm.gpu.gfx942.1-xxxx
    /^([a-z]+\.[a-z0-9.]+\.[a-z0-9]+)/i, // linux.rocm.gpu prefix
  ];

  for (const pattern of namePatterns) {
    const match = runnerName.match(pattern);
    if (match) {
      return match[1]; // Return the prefix part
    }
  }

  // If name starts with a dotted pattern, extract it
  if (runnerName.includes(".")) {
    const parts = runnerName.split("-");
    if (parts[0].includes(".")) {
      return parts[0];
    }
  }

  return "unknown";
}

// Helper function for sorting - pushes "unknown" labels to the end
export function unknownGoesLast(
  a: { label: string },
  b: { label: string }
): number {
  if (a.label === "unknown" && b.label !== "unknown") return 1;
  if (a.label !== "unknown" && b.label === "unknown") return -1;
  return 0;
}

export function groupRunners(runners: RunnerData[]): RunnerGroup[] {
  const groups = new Map<string, RunnerData[]>();

  // Group runners by label
  for (const runner of runners) {
    const label = getRunnerGroupLabel(runner);
    if (!groups.has(label)) {
      groups.set(label, []);
    }
    groups.get(label)!.push(runner);
  }

  // Convert to RunnerGroup format with counts
  const result: RunnerGroup[] = [];
  for (const [label, groupRunners] of groups.entries()) {
    const idleCount = groupRunners.filter(
      (r) => r.status === "online" && !r.busy
    ).length;
    const busyCount = groupRunners.filter(
      (r) => r.status === "online" && r.busy
    ).length;
    const offlineCount = groupRunners.filter(
      (r) => r.status === "offline"
    ).length;

    // Helper function to get status priority: idle (0), busy (1), offline (2)
    const getStatusPriority = (runner: RunnerData): number => {
      if (runner.status === "offline") return 2;
      if (runner.status === "online" && runner.busy) return 1;
      return 0; // idle
    };

    // Sort runners by status (idle, busy, offline) then by name
    const sortedRunners = groupRunners.sort((a, b) => {
      // First compare by status priority
      const statusComparison = getStatusPriority(a) - getStatusPriority(b);

      // If status is the same, sort by name
      return statusComparison !== 0
        ? statusComparison
        : a.name.localeCompare(b.name);
    });

    result.push({
      label,
      totalCount: groupRunners.length,
      idleCount,
      busyCount,
      offlineCount,
      runners: sortedRunners,
    });
  }

  // Sort groups by unknown status first, then by total count (descending)
  result.sort((a, b) => {
    const unknownComparison = unknownGoesLast(a, b);
    return unknownComparison !== 0
      ? unknownComparison
      : b.totalCount - a.totalCount;
  });

  return result;
}

