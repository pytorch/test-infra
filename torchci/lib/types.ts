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
  prUrl: string | null;
  diffNum: string | null;
  commitTitle: string;
  commitMessageBody: string;
  jobs: JobData[];
}

export interface RowData {
  sha: string;
  time: string;
  commitUrl: string;
  commitMessage: string;
  diffNum: string; // like: `D123456`
  prNum: number | null;
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

export function packHudParams(input: any) {
  return {
    repoOwner: input.repoOwner as string,
    repoName: input.repoName as string,
    branch: input.branch as string,
    page: parseInt(input.page as string),
    nameFilter: input.name_filter as string | undefined,
  };
}

export function formatHudURL(urlPrefix: string, params: HudParams): string {
  let base = `/${urlPrefix}/${params.repoOwner}/${
    params.repoName
  }/${encodeURIComponent(params.branch)}/${params.page}`;

  if (params.nameFilter != null) {
    base += `?name_filter=${encodeURIComponent(params.nameFilter)}`;
  }
  return base;
}
