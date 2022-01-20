import _ from "lodash";
import getRocksetClient from "./rockset";
import { HudParams, JobData, RowData } from "./types";

export default async function fetchHud(params: HudParams): Promise<{
  shaGrid: RowData[];
  jobNames: string[];
}> {
  const rocksetClient = getRocksetClient();
  const [hudQuery, commitQuery] = await Promise.all([
    rocksetClient.queryLambdas.executeQueryLambdaByTag(
      "commons",
      "hud_query",
      "prod",
      {
        parameters: [
          {
            name: "branch",
            type: "string",
            value: `refs/heads/${params.branch}`,
          },
          {
            name: "page",
            type: "int",
            value: params.page.toString(),
          },
        ],
      }
    ),
    rocksetClient.queryLambdas.executeQueryLambdaByTag(
      "commons",
      "master_commits",
      "prod",
      {
        parameters: [
          {
            name: "branch",
            type: "string",
            value: `refs/heads/${params.branch}`,
          },
          {
            name: "page",
            type: "int",
            value: params.page.toString(),
          },
        ],
      }
    ),
  ]);

  const commitsBySha = _.keyBy(commitQuery.results, "sha");
  let results = hudQuery.results;

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
      sha: sha,
      time: commit.timestamp,
      commitUrl: commit.url,
      diffNum: commit.diffNum,
      commitMessage: commit.message,
      prNum: commit.prNum,
      jobs: jobs,
    };
    shaGrid.push(row);
  });
  return { shaGrid: shaGrid, jobNames: names };
}
