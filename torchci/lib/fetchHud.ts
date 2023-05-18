import _ from "lodash";
import { commitDataFromResponse, getOctokit } from "./github";
import getRocksetClient from "./rockset";
import { HudParams, JobData, RowData } from "./types";
import rocksetVersions from "rockset/prodVersions.json";
import { isFailure } from "./JobClassifierUtil";
import { isRerunDisabledTestsJob, isUnstableJob } from "./jobUtils";

export default async function fetchHud(params: HudParams): Promise<{
  shaGrid: RowData[];
  jobNames: string[];
}> {
  // Retrieve commit data from GitHub
  const octokit = await getOctokit(params.repoOwner, params.repoName);
  const branch = await octokit.rest.repos.listCommits({
    owner: params.repoOwner,
    repo: params.repoName,
    sha: params.branch,
    per_page: params.per_page,
    page: params.page,
  });
  const commits = branch.data.map(commitDataFromResponse);

  // Retrieve job data from rockset
  const shas = commits.map((commit) => commit.sha);
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
          value: `${params.repoOwner}/${params.repoName}`,
        },
      ],
    }
  );

  // Check if any of these commits are forced merge
  const filterForcedMergePr =
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
    );
  const forcedMergeShas = new Set(
    _.map(filterForcedMergePr.results, (result) => {
      return result.merge_commit_sha;
    })
  );

  const commitsBySha = _.keyBy(commits, "sha");
  let results = hudQuery.results;

  if (params.filter_reruns) {
    results = results?.filter((job: JobData) => !isRerunDisabledTestsJob(job));
  }
  if (params.filter_unstable) {
    results = results?.filter((job: JobData) => !isUnstableJob(job));
  }

  const namesSet: Set<string> = new Set();
  // Built a list of all the distinct job names.
  results?.forEach((job: JobData) => {
    namesSet.add(job.name!);
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
    };
    shaGrid.push(row);
  });
  return { shaGrid: shaGrid, jobNames: names };
}
