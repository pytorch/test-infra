import { Group } from "components/HudGroupingSettings/mainPageSettingsUtils";
import { GroupedJobStatus, JobStatus } from "components/job/GroupJobConclusion";
import { getOpenUnstableIssues } from "lib/jobUtils";
import { IssueData } from "./types";

// Accepts a list of group names and returns that list sorted according to
// the order defined in HUD_GROUP_SORTING
export function sortGroupNamesForHUD(
  groupNames: string[],
  groupSettings: Group[]
): string[] {
  let result: string[] = [];
  for (const group of groupSettings.sort(
    (a, b) => a.displayPriority - b.displayPriority
  )) {
    if (groupNames.includes(group.name)) {
      result.push(group.name);
    }
  }

  // Be flexible in case against any groups were left out of HUD_GROUP_SORTING
  let remaining = groupNames.filter((x) => !result.includes(x));

  result = result.concat(remaining);
  return result;
}

export function getGroupConclusionChar(conclusion?: GroupedJobStatus): string {
  switch (conclusion) {
    case GroupedJobStatus.Success:
      return "O";
    case GroupedJobStatus.Failure:
      return "X";
    case GroupedJobStatus.Queued:
      return "Q";
    case GroupedJobStatus.Pending:
      return "?";
    case GroupedJobStatus.AllNull:
      return "~";
    case GroupedJobStatus.Classified:
      return "X";
    case GroupedJobStatus.Flaky:
      return "F";
    case GroupedJobStatus.WarningOnly:
      return "W";
    default:
      return "U";
  }
}

export function isFailure(conclusion?: string): boolean {
  switch (conclusion) {
    case JobStatus.Failure:
    case JobStatus.Cancelled:
    case JobStatus.Timed_out:
      return true;
    case JobStatus.Success:
    case JobStatus.Neutral:
    case JobStatus.Skipped:
    case JobStatus.Queued:
    case JobStatus.Pending:
    case undefined:
    default:
      return false;
  }
}

export function IsJobInProgress(conclusion?: string): boolean {
  switch (conclusion) {
    case JobStatus.Queued:
    case JobStatus.Pending:
      return true;
    case JobStatus.Success:
    case JobStatus.Neutral:
    case JobStatus.Skipped:
    case JobStatus.Failure:
    case JobStatus.Cancelled:
    case JobStatus.Timed_out:
    case undefined:
    default:
      return false;
  }
}

export function getConclusionChar(
  conclusion?: string,
  failedPreviousRun?: boolean
): string {
  switch (conclusion) {
    case JobStatus.Success:
      if (failedPreviousRun) {
        return "F";
      }
      return "O";
    case JobStatus.Failure:
      return "X";
    case JobStatus.Neutral:
      return "N";
    case JobStatus.Cancelled:
      return "C";
    case JobStatus.Timed_out:
      return "T";
    case JobStatus.Skipped:
      return "S";
    case JobStatus.Queued:
      return "Q";
    case JobStatus.Pending:
      return "?";
    case undefined:
      return "~";
    default:
      return "U";
  }
}

export function getConclusionSeverityForSorting(conclusion?: string): number {
  // Returns a severity level for the conclusion.
  // Used to sort jobs by severity
  switch (conclusion) {
    case JobStatus.Success:
      return 0;
    case JobStatus.Skipped:
      return 1;
    case JobStatus.Neutral:
      return 2;
    case JobStatus.Cancelled:
      return 3;
    case JobStatus.Queued:
      return 4;
    case JobStatus.Pending:
      return 5;
    case undefined:
      return 6;
    case JobStatus.Failure:
      return 7;
    default:
      return 8;
  }
}

export function isPersistentGroup(groups: Group[], name: string) {
  return (
    groups.filter((group) => group.name == name && group.persistent).length !==
    0
  );
}

export function isUnstableGroup(name: string, unstableIssues?: IssueData[]) {
  const openUnstableIssues = getOpenUnstableIssues(name, unstableIssues);
  return (
    name.toLocaleLowerCase().includes("unstable") ||
    (openUnstableIssues !== undefined && openUnstableIssues.length !== 0)
  );
}

export function getNameWithoutLF(name: string) {
  const lfRegex = /, lf\.(ephemeral|linux|windows)/g;
  name = name.replace(lfRegex, ", $1");
  const ephemeralRegex = /, ephemeral\.(linux|windows)/g;
  return name.replace(ephemeralRegex, ", $1");
}
