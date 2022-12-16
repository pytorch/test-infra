/**
 * Represents the individual job information returned by Rockset.
 */
export interface JobData {
  name?: string;
  workflowName?: string;
  jobName?: string;
  sha?: string;
  id?: string;
  branch?: string;
  workflowId?: string;
  githubArtifactUrl?: string;
  time?: string;
  conclusion?: string;
  htmlUrl?: string;
  logUrl?: string;
  durationS?: number;
  queueTimeS?: number;
  failureLine?: string;
  failureLineNumber?: number;
  failureCaptures?: string;
  repo?: string;
  failureAnnotation?: string;
  failedPreviousRun?: boolean;
}

export interface Artifact {
  name: string;
  kind: string;
  expired: boolean;
  sizeInBytes: number;
  url: string;
}

export interface GroupData {
  groupName: string;
  jobs: JobData[];
}

export interface CommitData {
  sha: string;
  time: string;
  prNum: number | null;
  diffNum: string | null;
  commitUrl: string;
  commitTitle: string;
  commitMessageBody: string;
  author: string;
  authorUrl: string | null;
}

export interface RowData extends CommitData {
  jobs: JobData[];
  groupedJobs?: Map<string, GroupData>;
  isForcedMerge: boolean | false;
  nameToJobs?: Map<string, JobData>
}

export interface HudData {
  shaGrid: RowData[];
  jobNames: string[];
}

export interface IssueData {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  body: string;
}

export interface HudParams {
  repoOwner: string;
  repoName: string;
  branch: string;
  page: number;
  per_page: number;
  nameFilter?: string;
}

export interface PRData {
  title: string;
  shas: { sha: string; title: string }[];
}

export interface FlakyTestData {
  file: string;
  suite: string;
  name: string;
  numGreen?: number;
  numRed?: number;
  workflowIds: string[];
  workflowNames: string[];
  jobIds: number[];
  jobNames: string[];
  branches: string[];
  eventTimes?: string[];
}

export interface DisabledNonFlakyTestData {
  name: string;
  classname: string;
  filename: string;
  flaky: boolean;
  num_green: number;
  num_red: number;
}

export interface RecentWorkflowsData {
  id: string;
  name: string;
  conclusion: string | null;
  completed_at: string | null;
  html_url: string;
  head_sha: string;
  pr_number?: number;
  failure_captures: string[];
}

export interface TTSChange {
  name: string | undefined;
  htmlUrl: string | undefined;
  duration: string;
  color: string;
  percentChangeString: string;
  absoluteChangeString: string;
}

export function packHudParams(input: any) {
  return {
    repoOwner: input.repoOwner as string,
    repoName: input.repoName as string,
    branch: input.branch as string,
    page: parseInt((input.page as string) ?? 1),
    per_page: parseInt((input.per_page as string) ?? 50),
    nameFilter: input.name_filter as string | undefined,
  };
}

export function formatHudUrlForFetch(
  urlPrefix: string,
  params: HudParams
): string {
  return formatHudURL(urlPrefix, params, /*keepFilter=*/ false);
}

export function formatHudUrlForRoute(
  urlPrefix: string,
  params: HudParams
): string {
  return formatHudURL(urlPrefix, params, /*keepFilter=*/ true);
}

function formatHudURL(
  urlPrefix: string,
  params: HudParams,
  keepFilter: boolean
): string {
  let base = `/${urlPrefix}/${params.repoOwner}/${
    params.repoName
  }/${encodeURIComponent(params.branch)}/${params.page}`;

  base += `?per_page=${params.per_page}`;

  if (params.nameFilter != null && keepFilter) {
    base += `&name_filter=${encodeURIComponent(params.nameFilter)}`;
  }
  return base;
}
