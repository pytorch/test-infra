import _ from "lodash";
import { getOctokit } from "./github";
import getRocksetClient from "./rockset";
import { HudCommitData, HudParams, JobData, RowData } from "./types";

async function getCommitData(params: HudParams): Promise<HudCommitData[]> {
  const prRegex = /Pull Request resolved: .*?(\d+)'/;
  const phabRegex = /Differential Revision: (D.*)/;

  const octokit = await getOctokit(params.repoOwner, params.repoName);
  const branch = await octokit.rest.repos.listCommits({
    owner: params.repoOwner,
    repo: params.repoName,
    sha: params.branch,
    per_page: 50,
    page: params.page,
  });
  const commitData = branch.data.map((data) => {
    const message = data.commit.message;
    const prMatch = message.match(prRegex);
    let prNum = null;
    if (prMatch) {
      prNum = parseInt(prMatch[1]);
    }

    const phabMatch = message.match(phabRegex);
    let diffNum = null;
    if (phabMatch) {
      diffNum = phabMatch[1];
    }

    return {
      time: data.commit.committer!.date as string,
      sha: data.sha,
      commitUrl: data.html_url,
      commitMessage: data.commit.message.split("\n")[0],
      prNum,
      diffNum,
    };
  });
  return commitData;
}

export default async function fetchHud(params: HudParams): Promise<{
  shaGrid: RowData[];
  jobNames: string[];
}> {
  const commits = await getCommitData(params);

  // Retrieve job data from rockset
  const shas = commits.map((commit) => commit.sha);
  const rocksetClient = getRocksetClient();
  const hudQuery = await rocksetClient.queryLambdas.executeQueryLambda(
    "commons",
    "hud_query",
    "cee7578c7a095800",
    {
      parameters: [
        {
          name: "shas",
          type: "string",
          value: shas.join(","),
        },
      ],
    }
  );

  const commitsBySha = _.keyBy(commits, "sha");
  const results = hudQuery.results;

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
    };
    shaGrid.push(row);
  });
  return { shaGrid: shaGrid, jobNames: names };
}
