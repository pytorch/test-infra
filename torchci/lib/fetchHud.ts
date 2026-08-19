import { JobStatus } from "components/job/GroupJobConclusion";
import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import _ from "lodash";
import { queryClickhouseSaved } from "./clickhouse";
import {
  commitDataFromResponse,
  getOctokit,
  parsePrAndDiffNumbers,
} from "./github";
import {
  getNameWithoutLF,
  getNameWithoutOSDC,
  isFailure,
} from "./JobClassifierUtil";
import { isRerunDisabledTestsJob, isUnstableJob } from "./jobUtils";
import {
  CommitData,
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

// Map a hud_commits row to the same CommitData shape commitDataFromResponse
// produces. The push mirror stores author.username as "" (never null) when no
// GitHub user was resolved, so "" means: use the git author name and no URL.
function commitDataFromPushRow(row: any): CommitData {
  const message = row.message as string;
  const { prNum, diffNum } = parsePrAndDiffNumbers(message);
  const username = (row.author_username as string) ?? "";
  return {
    author: username !== "" ? username : (row.author_name as string),
    authorUrl: username !== "" ? `https://github.com/${username}` : null,
    time: row.timestamp as string,
    sha: row.sha as string,
    commitUrl: row.url as string,
    commitTitle: message.split("\n")[0],
    commitMessageBody: message,
    prNum,
    diffNum,
  };
}

// Commit list for the HUD grid, read from the push mirror first so a normal page
// load never calls GitHub. Falls back to GitHub's listCommits only when the
// mirror can't answer authoritatively: a raw-sha branch (the mirror isn't keyed
// by sha), a ClickHouse error, or fewer than per_page rows returned (empty branch
// or a deep page past what the mirror holds). The guard is count-only: a full
// page never triggers fallback, so a just-landed tip not yet ingested can briefly
// be missing from page 1 until the next ingest (display-only, self-heals).
async function fetchCommits(params: HudParams): Promise<CommitData[]> {
  const branch = decodeURIComponent(params.branch);
  const isRawSha = /^[0-9a-f]{40}$/i.test(branch);

  let chCommits: CommitData[] | undefined;
  if (!isRawSha) {
    try {
      const rows = await queryClickhouseSaved("hud_commits", {
        repo: `${params.repoOwner}/${params.repoName}`,
        branch,
        per_page: params.per_page,
        offset: (params.page - 1) * params.per_page,
      });
      chCommits = rows.map(commitDataFromPushRow);
    } catch (e) {
      console.warn(
        `fetchHud: ClickHouse hud_commits query failed for ${params.repoOwner}/${params.repoName}@${branch}, falling back to GitHub`,
        e
      );
    }
  }

  if (chCommits !== undefined && chCommits.length >= params.per_page) {
    return chCommits;
  }

  const octokit = await getOctokit(params.repoOwner, params.repoName);
  const githubCommits = await octokit.rest.repos.listCommits({
    owner: params.repoOwner,
    repo: params.repoName,
    sha: branch,
    per_page: params.per_page,
    page: params.page,
  });
  return githubCommits.data.map(commitDataFromResponse);
}

export default async function fetchHud(
  params: HudParams
): Promise<HudDataAPIResponse> {
  const commits = await fetchCommits(params);

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

  // Construct mapping of sha => job name => job data
  const jobsBySha: {
    [sha: string]: { [name: string]: JobData };
  } = {};
  results!.forEach((job: JobData) => {
    if (jobsBySha[job.sha!] === undefined) {
      jobsBySha[job.sha!] = {};
    }
    let key = job.name!;
    if (params.mergeEphemeralLF) {
      key = getNameWithoutLF(key);
    }
    if (params.mergeOSDC) {
      key = getNameWithoutOSDC(key);
    }

    const existingJob = jobsBySha[job.sha!][key];
    if (existingJob !== undefined) {
      // If there are multiple jobs with the same name, we want the most recent.
      // Q: How can there be more than one job with the same name for a given sha?
      // A: Periodic builds can be scheduled multiple times for one sha. In those
      // cases, we want the most recent job to be shown.
      // Exception: a `skipped` conclusion has lower priority than any other
      // status, so a real result always wins over a skip even if the skipped
      // job has a larger id. This matters for the OSDC merge, where the
      // unselected variant reports as skipped and would otherwise mask a real
      // failure on the selected variant.
      const existingSkipped = existingJob.conclusion === JobStatus.Skipped;
      const jobSkipped = job.conclusion === JobStatus.Skipped;
      const replace =
        existingSkipped && !jobSkipped
          ? true
          : !existingSkipped && jobSkipped
          ? false
          : job.id! > existingJob.id!;
      if (replace) {
        jobsBySha[job.sha!][key] = job;
        jobsBySha[job.sha!][key].failedPreviousRun =
          existingJob.failedPreviousRun || isFailure(existingJob.conclusion);
      } else {
        existingJob.failedPreviousRun =
          existingJob.failedPreviousRun || isFailure(job.conclusion);
      }
    } else {
      jobsBySha[job.sha!][key] = job;
    }
  });

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
