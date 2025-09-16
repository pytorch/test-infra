import { Group } from "components/HudGroupingSettings/mainPageSettingsUtils";
import { isFailure } from "lib/JobClassifierUtil";
import { getOpenUnstableIssues } from "lib/jobUtils";
import { IssueData, RowData } from "lib/types";
import {
  getDefaultGroupSettings,
  GROUP_OTHER,
  GROUP_UNSTABLE,
} from "./defaults";
import { getStoredTreeData } from "./mainPageSettingsUtils";

function getGroupSettings() {
  const groups = getStoredTreeData() ?? getDefaultGroupSettings();
  groups.push({
    name: GROUP_OTHER,
    regex: /.*/,
    filterPriority: groups.length,
    displayPriority: groups.length,
    persistent: false,
  });
  return groups;
}

export function getGroupingData(
  shaGrid: RowData[],
  jobNames: Set<string>,
  showUnstableGroup: boolean,
  unstableIssues?: IssueData[]
) {
  // Construct Job Groupping Mapping
  const groupSettings = getGroupSettings();

  const groupNameMapping = new Map<string, Array<string>>(); // group -> [job names]

  // Track which jobs have failures
  const jobsWithFailures = new Set<string>();

  // First pass: check failures for each job across all commits
  for (const name of jobNames) {
    // Check if this job has failures in any commit
    const hasFailure = shaGrid.some((row) => {
      const job = row.nameToJobs.get(name);
      return job && isFailure(job.conclusion);
    });

    if (hasFailure) {
      jobsWithFailures.add(name);
    }
  }

  for (const name of jobNames) {
    const groupName = classifyGroup(
      name,
      showUnstableGroup,
      groupSettings,
      unstableIssues
    );
    const jobsInGroup = groupNameMapping.get(groupName) ?? [];
    jobsInGroup.push(name);
    groupNameMapping.set(groupName, jobsInGroup);
  }

  // Calculate which groups have failures
  const groupsWithFailures = new Set<string>();
  for (const [groupName, jobs] of groupNameMapping.entries()) {
    if (jobs.some((jobName) => jobsWithFailures.has(jobName))) {
      groupsWithFailures.add(groupName);
    }
  }

  return {
    shaGrid,
    groupNameMapping,
    jobsWithFailures,
    groupsWithFailures,
    groupSettings,
  };
}

// Accepts a list of group names and returns that list sorted according to
// the order defined in HUD_GROUP_SORTING
export function sortGroupNamesForHUD(
  groupNames: string[],
  groups: Group[]
): string[] {
  let result = groupNames.sort((a, b) => {
    return (
      groups.find((g) => g.name === a)!.displayPriority -
      groups.find((g) => g.name === b)!.displayPriority
    );
  });

  // Be flexible in case against any groups were left out of HUD_GROUP_SORTING
  let remaining = groupNames.filter((x) => !result.includes(x));

  result = result.concat(remaining);
  return result;
}

export function classifyGroup(
  jobName: string,
  showUnstableGroup: boolean,
  groups: Group[],
  unstableIssues?: IssueData[]
): string {
  const openUnstableIssues = getOpenUnstableIssues(jobName, unstableIssues);
  let assignedGroup = undefined;
  for (const group of groups.sort(
    (a, b) => a.filterPriority - b.filterPriority
  )) {
    if (jobName.match(group.regex)) {
      assignedGroup = group;
      break;
    }
  }

  // Check if the job has been marked as unstable but doesn't include the
  // unstable keyword.
  if (!showUnstableGroup && assignedGroup?.persistent) {
    // If the unstable group is not being shown, then persistent groups (mem
    // leak check, rerun disabled tests) should not be overwritten
    return assignedGroup.name;
  }

  if (openUnstableIssues !== undefined && openUnstableIssues.length !== 0) {
    return GROUP_UNSTABLE;
  }

  return assignedGroup === undefined ? GROUP_OTHER : assignedGroup.name;
}
