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
    // Handle macOS synonyms
    const macosLabels = validLabels.filter((name) => name.startsWith("macos-"));
    if (macosLabels.length > 1) {
      // Check for known synonym patterns
      const m1Labels = macosLabels.filter((name) => name.includes("m1"));
      const m2Labels = macosLabels.filter((name) => name.includes("m2"));

      if (m1Labels.length > 1) {
        return m1Labels.sort().join(" / "); // e.g., "macos-m1-14 / macos-m1-stable"
      }
      if (m2Labels.length > 1) {
        return m2Labels.sort().join(" / "); // e.g., "macos-m2-15 / macos-m2-stable"
      }

      // If multiple macOS labels but not synonyms, use first one
      return macosLabels[0];
    }

    // Use first valid label (could be dot notation or single macOS label)
    return validLabels[0];
  }

  // Fallback: Parse runner name for grouping info
  // Special case for ROCm runners provided by external partners that don't have proper GitHub labels
  // but use naming conventions like: linux.rocm.gpu.gfx942.1-xb8kr-runner-gnr2v
  const runnerName = runner.name;

  // Look for dotted prefixes before "-runner-" or "-" followed by random suffix
  const namePatterns = [
    /^([a-z]+\.[a-z0-9.]+)-[a-z0-9]+-runner-[a-z0-9]+$/i, // linux.rocm.gpu.gfx942.1-xb8kr-runner-gnr2v
    /^([a-z]+\.[a-z0-9.]+)-[a-z0-9]+$/i, // linux.rocm.gpu.gfx942.1-xb8kr
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

    // Sort runners by status (idle, busy, offline) then by name
    const sortedRunners = groupRunners.sort((a, b) => {
      // Status priority: idle (0), busy (1), offline (2)
      const getStatusPriority = (runner: RunnerData) => {
        if (runner.status === "offline") return 2;
        if (runner.status === "online" && runner.busy) return 1;
        return 0; // idle
      };

      const aPriority = getStatusPriority(a);
      const bPriority = getStatusPriority(b);

      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      // Same status, sort by name
      return a.name.localeCompare(b.name);
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

  // Sort groups by total count (descending), then unknown last
  result.sort((a, b) => {
    if (a.label === "unknown" && b.label !== "unknown") return 1;
    if (a.label !== "unknown" && b.label === "unknown") return -1;
    // Sort by total count descending
    return b.totalCount - a.totalCount;
  });

  return result;
}

export async function checkUserPermissions(
  authorization: string
): Promise<boolean> {
  // This function would validate user permissions
  // Implementation depends on how user tokens are structured
  // For now, return true for testing - this should be implemented properly
  return true;
}
