import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import _ from "lodash";
import { queryClickhouseSaved } from "./clickhouse";
import { commitDataFromResponse, getOctokit } from "./github";
import { getNameWithoutLF, getNameWithoutOSDC } from "./JobClassifierUtil";
import { isRerunDisabledTestsJob, isUnstableJob } from "./jobUtils";
import { mergeCellRuns } from "./mergeCellRuns";
import {
  HudDataAPIResponse,
  HudParams,
  JobData,
  RowDataAPIResponse,
} from "./types";

async function fetchDatabaseInfo(owner: string, repo: string, shas: string[]) {
  const response = await queryClickhouseSaved("hud_query", {
    repo: `${owner}/${repo}`,
    shas: shas,
  });

  for (const row of response) {
    row.id = row.id == 0 ? null : row.id;
    if (row.failureAnnotation === "") {
      // Rockset returns nothing if the left join doesn't have a match but CH returns empty string
      // TODO: change code that consumes this to handle empty or nulls when Rockset is deprecated
      delete row.failureAnnotation;
    }
  }
  return response;
}

export default async function fetchHud(
  params: HudParams
): Promise<HudDataAPIResponse> {
  // Retrieve commit data from GitHub
  const octokit = await getOctokit(params.repoOwner, params.repoName);
  const branch = await octokit.rest.repos.listCommits({
    owner: params.repoOwner,
    repo: params.repoName,
    sha: decodeURIComponent(params.branch),
    per_page: params.per_page,
    page: params.page,
  });
  const commits = branch.data.map(commitDataFromResponse);

  // Retrieve job data from the database
  const shas = commits.map((commit) => commit.sha);
  const response = await fetchDatabaseInfo(
    params.repoOwner,
    params.repoName,
    shas
  );
  let results = response as any[];

  // Check if any of these commits are forced merge
  const filterForcedMergePr = await queryClickhouseSaved(
    "filter_forced_merge_pr",
    {
      owner: params.repoOwner,
      project: params.repoName,
      shas: shas,
    }
  );

  const forcedMergeShas = new Set(
    _.map(filterForcedMergePr, (r) => {
      return r.merge_commit_sha;
    })
  );
  const forcedMergeWithFailuresShas = new Set(
    _.map(
      _.filter(filterForcedMergePr, (r) => {
        return r.force_merge_with_failures !== 0;
      }),
      (r) => {
        return r.merge_commit_sha;
      }
    )
  );

  // Check if any of these commits were autoreverted
  const autorevertedCommits = await queryClickhouseSaved("autorevert_commits", {
    repo: `${params.repoOwner}/${params.repoName}`,
    shas: shas,
  });

  // Create a map from sha to autorevert data
  const autorevertDataBySha = new Map<
    string,
    { workflows: string[]; signals: string[] }
  >();
  autorevertedCommits.forEach((r) => {
    // Flatten the nested arrays
    const allWorkflows = r.all_workflows.flat();
    const allSignals = r.all_source_signal_keys.flat();

    autorevertDataBySha.set(r.commit_sha, {
      workflows: allWorkflows,
      signals: allSignals,
    });
  });

  const commitsBySha = _.keyBy(commits, "sha");

  if (params.filter_reruns) {
    results = results?.filter((job: JobData) => !isRerunDisabledTestsJob(job));
  }
  if (params.filter_unstable) {
    const unstableIssues = await fetchIssuesByLabel("unstable", /*cache*/ true);
    results = results?.filter(
      (job: JobData) => !isUnstableJob(job, unstableIssues ?? [])
    );
  }

  // Collect every run that reported for a (sha, job name) cell, then merge the whole set at once.
  //
  // Q: How can there be more than one run with the same name for a given sha?
  // A: Periodic builds can be scheduled multiple times for one sha; a job can be re-run, producing a
  //    new attempt; and autorevert dispatches restart runs against a trunk/<sha> ref.
  //
  // All three are just runs. The merge is issuer-agnostic and order-independent by construction --
  // see mergeCellRuns. It replaced a pairwise newest-id-wins reducer under which the verdict depended
  // on arrival order, so a natural pass followed by a restart failure rendered plain red while the
  // reverse order rendered flaky.
  const runsBySha: {
    [sha: string]: { [name: string]: JobData[] };
  } = {};
  results!.forEach((job: JobData) => {
    if (runsBySha[job.sha!] === undefined) {
      runsBySha[job.sha!] = {};
    }
    let key = job.name!;
    if (params.mergeEphemeralLF) {
      key = getNameWithoutLF(key);
    }
    if (params.mergeOSDC) {
      key = getNameWithoutOSDC(key);
    }
    (runsBySha[job.sha!][key] ??= []).push(job);
  });

  const jobsBySha: {
    [sha: string]: { [name: string]: JobData };
  } = {};
  for (const sha in runsBySha) {
    jobsBySha[sha] = {};
    for (const key in runsBySha[sha]) {
      jobsBySha[sha][key] = mergeCellRuns(runsBySha[sha][key]);
    }
  }

  const namesSet: Set<string> = new Set();

  // Built a list of all the distinct job names.
  Object.values(jobsBySha).forEach((jobs) => {
    for (const name in jobs) {
      namesSet.add(name);
    }
  });
  const names = Array.from(namesSet).sort();

  const shaGrid: RowDataAPIResponse[] = [];

  _.forEach(commitsBySha, (commit, sha) => {
    const jobs: JobData[] = [];
    const nameToJobs = jobsBySha[sha];
    for (const name of names) {
      if (nameToJobs === undefined || nameToJobs[name] === undefined) {
        jobs.push({});
      } else {
        const job = nameToJobs[name];
        // Strip nulls and job name to reduce payload size, this actually saves
        // a lot (~1.3mb) of payload size.
        job.name = undefined;
        const nullsStripped = Object.fromEntries(
          Object.entries(job).filter(([_, v]) => v != null)
        );
        jobs.push(nullsStripped as JobData);
      }
    }

    const autorevertData = autorevertDataBySha.get(commit.sha);
    const row = {
      ...commit,
      jobs: jobs,
      isForcedMerge: forcedMergeShas.has(commit.sha),
      isForcedMergeWithFailures: forcedMergeWithFailuresShas.has(commit.sha),
      isAutoreverted: autorevertData !== undefined,
      autorevertWorkflows: autorevertData?.workflows,
      autorevertSignals: autorevertData?.signals,
    };
    shaGrid.push(row);
  });
  return { shaGrid: shaGrid, jobNames: names };
}
