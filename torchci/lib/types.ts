/**
 * Represents the individual job information returned by Rockset.
 */
export interface JobData {
  name?: string;
  workflowName?: string;
  jobName?: string;
  sha?: string;
  id?: string;
  time?: string;
  conclusion?: string;
  htmlUrl?: string;
  logUrl?: string;
  durationS?: number;
  failureLine?: string;
  failureLineNumber?: number;
  failureContext?: string;
  failureCaptures?: string;
  originalPrData?: JobData;
}

export interface CommitData {
  sha: string;
  time: string;
  prNum: number | null;
  diffNum: string | null;
  commitUrl: string;
  commitTitle: string;
  commitMessageBody: string;
}

export interface RowData extends CommitData {
  jobs: JobData[];
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
}

export interface HudParams {
  repoOwner: string;
  repoName: string;
  branch: string;
  page: number;
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
  num_green: number;
  num_red: number;
  workflow_ids: string[];
  workflow_names: string[];
}

export function packHudParams(input: any) {
  return {
    repoOwner: input.repoOwner as string,
    repoName: input.repoName as string,
    branch: input.branch as string,
    page: parseInt(input.page as string),
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

  if (params.nameFilter != null && keepFilter) {
    base += `?name_filter=${encodeURIComponent(params.nameFilter)}`;
  }
  return base;
}
