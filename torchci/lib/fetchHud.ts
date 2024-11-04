import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import _ from "lodash";
import rocksetVersions from "rockset/prodVersions.json";
import { queryClickhouseSaved } from "./clickhouse";
import { commitDataFromResponse, getOctokit } from "./github";
import { isFailure } from "./JobClassifierUtil";
import { isRerunDisabledTestsJob, isUnstableJob } from "./jobUtils";
import getRocksetClient from "./rockset";
import { HudParams, JobData, RowData } from "./types";

async function fetchDatabaseInfo(
  owner: string,
  repo: string,
  shas: string[],
  useCH: boolean
) {
  if (useCH) {
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
  } else {
    const rocksetClient = getRocksetClient();
    const hudQuery = await rocksetClient.queryLambdas.executeQueryLambda(
      "commons",
      "hud_query",
      rocksetVersions.commons.hud_query,
      {
        parameters: [
          {
            name: "shas",
            type: "string",
            value: shas.join(","),
          },
          {
            name: "repo",
            type: "string",
            value: `${owner}/${repo}`,
          },
        ],
      }
    );
    return hudQuery.results!;
  }
}

export default async function fetchHud(params: HudParams): Promise<{
  shaGrid: RowData[];
  jobNames: string[];
}> {
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
  const rocksetClient = getRocksetClient();

  // Retrieve job data from rockset
  const shas = commits.map((commit) => commit.sha);
  const response = await fetchDatabaseInfo(
    params.repoOwner,
    params.repoName,
    shas,
    params.use_ch
  );
  let results = response as any[];

  // Check if any of these commits are forced merge
  const filterForcedMergePr = params.use_ch
    ? ((await queryClickhouseSaved("filter_forced_merge_pr", {
        owner: params.repoOwner,
        project: params.repoName,
        shas: shas,
      })) as any[])
    : (
        await rocksetClient.queryLambdas.executeQueryLambda(
          "commons",
          "filter_forced_merge_pr",
          rocksetVersions.commons.filter_forced_merge_pr,
          {
            parameters: [
              {
                name: "shas",
                type: "string",
                value: shas.join(","),
              },
              {
                name: "owner",
                type: "string",
                value: params.repoOwner,
              },
              {
                name: "project",
                type: "string",
                value: params.repoName,
              },
            ],
          }
        )
      ).results;

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

  const commitsBySha = _.keyBy(commits, "sha");

  if (params.filter_reruns) {
    results = results?.filter((job: JobData) => !isRerunDisabledTestsJob(job));
  }
  if (params.filter_unstable) {
    const unstableIssues = await fetchIssuesByLabel("unstable");
    results = results?.filter(
      (job: JobData) => !isUnstableJob(job, unstableIssues ?? [])
    );
  }

  const namesSet: Set<string> = new Set();
  // Built a list of all the distinct job names, and set the conclusion based on the status.
  results?.forEach((job: JobData) => {
    namesSet.add(job.name!);

    // If job is not complete, get the status.
    if (job.conclusion == "") {
      job.conclusion = getConclusionFromStatus(job);
    }
  });
  const names = Array.from(namesSet).sort();

  // Construct mapping of sha => job name => job data
  const jobsBySha: {
    [sha: string]: { [name: string]: JobData };
  } = {};
  results!.forEach((job: JobData) => {
    if (jobsBySha[job.sha!] === undefined) {
      jobsBySha[job.sha!] = {};
    }

    const existingJob = jobsBySha[job.sha!][job.name!];
    if (existingJob !== undefined) {
      // If there are multiple jobs with the same name, we want the most recent.
      // Q: How can there be more than one job with the same name for a given sha?
      // A: Periodic builds can be scheduled multiple times for one sha. In those
      // cases, we want the most recent job to be shown.
      if (job.id! > existingJob.id!) {
        jobsBySha[job.sha!][job.name!] = job;
        jobsBySha[job.sha!][job.name!].failedPreviousRun =
          existingJob.failedPreviousRun || isFailure(existingJob.conclusion);
      } else {
        existingJob.failedPreviousRun =
          existingJob.failedPreviousRun || isFailure(job.conclusion);
      }
    } else {
      jobsBySha[job.sha!][job.name!] = job;
    }
  });

  const shaGrid: RowData[] = [];

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

    const row: RowData = {
      ...commit,
      jobs: jobs,
      isForcedMerge: forcedMergeShas.has(commit.sha),
      isForcedMergeWithFailures: forcedMergeWithFailuresShas.has(commit.sha),
    };
    shaGrid.push(row);
  });
  return { shaGrid: shaGrid, jobNames: names };
}

// See: https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28#list-workflow-runs-for-a-workflow
// the official API does not provide a clear list of the possible statuses, this is based on experience,
// we only care about the following, since conclusion covers all the other statuses.
// - pending: The job is pending. pending means the job is waiting for dependencies to be met.
// - queued: The job is queue. queued means the job is waiting for available resources.
// - in_progress: The job is in progress. The job is running.
function getConclusionFromStatus(job: JobData): string {
  switch (job.status) {
    case "pending":
    case "queued":
      return "pending";
    case "in_progress":
      return job.status;
    default:
      return "unknown";
  }
}
