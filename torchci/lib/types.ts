/**
 * Represents the individual job information returned by queries.
 */
export interface BasicJobData {
  name?: string;
  time?: string;
  conclusion?: string;
  status?: string;
  runnerName?: string;
  authorEmail?: string;
}

// Used by HUD
export interface JobData extends BasicJobData {
  workflowName?: string;
  jobName?: string;
  sha?: string;
  id?: string;
  branch?: string;
  workflowId?: string;
  githubArtifactUrl?: string;
  htmlUrl?: string;
  logUrl?: string;
  durationS?: number;
  queueTimeS?: number;
  failureLines?: string[];
  failureLineNumbers?: number[];
  failureCaptures?: string[];
  failureContext?: string[];
  repo?: string;
  failureAnnotation?: string;
  failedPreviousRun?: boolean;
}

// Used by Dr.CI
export interface RecentWorkflowsData extends BasicJobData {
  // only included if this is a job and not a workflow, if it is a workflow, the name is in the name field
  name: string; // In BasicJobData, but required here
  workflowId: number;
  // Each workflow file has an id. In the webhook this is workflow_id.
  // This can be used to group normal workflows (ex trunk) and those that failed
  // to run (ex .github/workflows/trunk.yml) together even when they have
  // different names.
  workflowUniqueId: number;
  jobName: string;
  id: number;
  completed_at: string;
  html_url: string;
  head_sha: string;
  head_sha_timestamp: string;
  head_branch: string;
  pr_number: number;
  failure_captures: string[];
  failure_lines: string[];
  failure_context: string[];
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

export interface Highlight {
  sha?: string;
  name?: string;
}

interface RowDataBase extends CommitData {
  isForcedMerge: boolean | false;
  isForcedMergeWithFailures: boolean | false;
}

export interface RowData extends RowDataBase {
  nameToJobs: Map<string, JobData>;
}

// Returned by the API instead of the above type because it results in a smaller
// response size
export interface RowDataAPIResponse extends RowDataBase {
  jobs: JobData[];
}

export interface HudDataAPIResponse {
  shaGrid: RowDataAPIResponse[];
  jobNames: string[];
}

export interface IssueData {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  body: string;
  updated_at: string;
  author_association: string;
  labels: string[];
}

export interface HudParams {
  repoOwner: string;
  repoName: string;
  branch: string;
  page: number;
  per_page: number;
  nameFilter?: string;
  filter_reruns: boolean;
  filter_unstable: boolean;
  mergeEphemeralLF?: boolean;
}

export interface PRData {
  title: string;
  body: string;
  shas: { sha: string; title: string }[];
}

export interface PRandJobs extends PRData {
  head_sha: string;
  head_sha_timestamp?: string;
  pr_number: number;
  jobs: RecentWorkflowsData[];
  merge_base: string;
  merge_base_date: string;
  owner: string;
  repo: string;
}

export interface FlakyTestData {
  file: string;
  suite: string;
  name: string;
  invoking_file: string;
  numGreen?: number;
  numRed?: number;
  workflowIds: string[];
  workflowNames: string[];
  jobIds: number[];
  jobNames: string[];
  branches: string[];
  eventTimes?: string[];
  sampleTraceback?: string;
}

export interface DisabledNonFlakyTestData {
  name: string;
  classname: string;
  filename: string;
  flaky: boolean;
  num_green: number;
  num_red: number;
}

export interface TTSChange {
  name: string | undefined;
  htmlUrl: string | undefined;
  duration: string;
  color: string;
  percentChangeString: string;
  absoluteChangeString: string;
}

export interface JobsPerCommitData {
  sha: string;
  author: string;
  body?: string;
  time: string;
  failures: string[];
  successes: string[];
}

export interface CompilerPerformanceData {
  abs_latency: number;
  accuracy: string;
  compilation_latency: number;
  compiler: string;
  compression_ratio: number;
  dynamo_peak_mem: number;
  eager_peak_mem: number;
  granularity_bucket: string;
  name: string;
  speedup: number;
  suite: string;
  workflow_id: number;
  job_id?: number;
}

export interface TritonBenchPerformanceData {
  metric_name: string;
  metric_value: number;
  granularity_bucket: string;
  name: string;
  workflow_id: number;
  head_branch: string;
  operator: string;
  suite: string;
  mode: string;
  dtype: string;
  backend: string;
}

export interface BenchmarkData {
  extra_info: { [key: string]: string };
  granularity_bucket: string;
  job_id: number;
  metric: string;
  model: string;
  quantization?: string;
  suite: string;
  value: number;
  workflow_id: number;
}

export interface RepoBranchAndCommit {
  repo: string;
  branch: string;
  commit: string;
  date?: string;
}

export interface BranchAndCommit {
  branch: string;
  commit: string;
  date?: string;
}

export enum JobAnnotation {
  NULL = "None",
  BROKEN_TRUNK = "Broken Trunk",
  TEST_FLAKE = "Test Flake",
  INFRA_BROKEN = "Broken Infra",
  INFRA_FLAKE = "Infra Flake",
  NETWORK = "Network Error",
  OTHER = "Other",
}

export enum LogAnnotation {
  NULL = "None",
  PREFER_TOP_LOG = "Prefer Top Log",
  PREFER_BOTTOM_LOG = "Prefer Bottom Log",
  PREFER_NEITHER = "Prefer Neither",
  SIMILAR_LOGS = "Similar Logs",
}

export function packHudParams(input: any) {
  return {
    repoOwner: input.repoOwner as string,
    repoName: input.repoName as string,
    branch: input.branch as string,
    page: parseInt((input.page as string) ?? 1),
    per_page: parseInt((input.per_page as string) ?? 50),
    nameFilter: input.name_filter as string | undefined,
    filter_reruns: input.filter_reruns ?? (false as boolean),
    filter_unstable: input.filter_unstable ?? (false as boolean),
    mergeEphemeralLF: input.mergeEphemeralLF as boolean,
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

  if (params.filter_reruns) {
    base += `&filter_reruns=true`;
  }

  if (params.filter_unstable) {
    base += `&filter_unstable=true`;
  }

  if (params.nameFilter != null && keepFilter) {
    base += `&name_filter=${encodeURIComponent(params.nameFilter)}`;
  }

  if (params.mergeEphemeralLF) {
    base += `&mergeEphemeralLF=true`;
  }

  return base;
}
