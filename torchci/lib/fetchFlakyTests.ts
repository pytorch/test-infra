import getRocksetClient from "./rockset";
import rocksetVersions from "rockset/prodVersions.json";

import { FlakyTestData } from "./types";

export default async function fetchFlakyTests(
  numHours: string = "3",
  testName: string = "%",
  testSuite: string = "%",
  testFile: string = "%"
): Promise<FlakyTestData[]> {
  const rocksetClient = getRocksetClient();
  const flakyTestQuery = await rocksetClient.queryLambdas.executeQueryLambda(
    "commons",
    "flaky_tests",
    rocksetVersions.commons.flaky_tests,
    {
      parameters: [
        {
          name: "numHours",
          type: "int",
          value: numHours,
        },
        {
          name: "name",
          type: "string",
          value: `%${testName}%`,
        },
        {
          name: "suite",
          type: "string",
          value: `%${testSuite}%`,
        },
        {
          name: "file",
          type: "string",
          value: `%${testFile}%`,
        },
      ],
    }
  );
  return flakyTestQuery.results ?? [];
}

export async function fetchFlakyTestsAcrossJobs(
  numHours: string = "3",
  threshold: number = 1,
  ignoreMessages: string = "No CUDA GPUs are available"
): Promise<FlakyTestData[]> {
  const rocksetClient = getRocksetClient();
  const flakyTestQuery = await rocksetClient.queryLambdas.executeQueryLambda(
    "commons",
    "flaky_tests_across_jobs",
    rocksetVersions.commons.flaky_tests_across_jobs,
    {
      parameters: [
        {
          name: "numHours",
          type: "int",
          value: numHours,
        },
        {
          name: "threshold",
          type: "int",
          value: threshold.toString(),
        },
        {
          name: "ignoreMessages",
          type: "string",
          value: ignoreMessages,
        },
      ],
    }
  );
  return flakyTestQuery.results ?? [];
}

export async function fetchFlakyTestsAcrossFileReruns(
  numHours: string = "3"
): Promise<FlakyTestData[]> {
  const rocksetClient = getRocksetClient();
  const failedTestsQuery = `
select
  DISTINCT
  t.name,
  t.file,
  t.invoking_file,
  t.classname,
from
  commons.test_run_s3 t
where
  t._event_time > CURRENT_TIMESTAMP() - HOURS(:numHours)
  and (
      t.failure is not null
      or t.error is not null
  )
  and t.file is not null
`;

  const checkEveryTestQuery = `
select
    t.name,
    t.classname as suite,
    t.file,
    t.invoking_file,
    t.job_id,
    1 as numGreen,
    SUM(
        if (
            t.failure is null,
            if(TYPEOF(t.rerun) = 'object', 1, Length(t.rerun)),
            if(TYPEOF(t.rerun) = 'object', 2, Length(t.rerun) + 1)
        )
    ) as numRed
FROM
    commons.test_run_s3 t
where
    t.name = :name
    and t.classname = :classname
    and t.invoking_file = :invoking_file
    and t.file = :file
    and t._event_time > CURRENT_TIMESTAMP() - HOURS(:numHours)
GROUP BY
    name,
    suite,
    file,
    invoking_file,
    job_id
HAVING
    BOOL_OR(t.failure is null)
    and BOOL_OR(t.failure is not null or t.error is not null)
`;

  const workflowJobInfoQuery = `
select
  j.name,
  w.name as workflow_name,
  j.id,
  w.id as workflow_id,
  w.head_branch,
  j.run_attempt,
  j.html_url
from
  workflow_job j join workflow_run w on w.id = j.run_id
where
  ARRAY_CONTAINS(SPLIT(:job_ids, ','), CAST(j.id as STRING))
`;

  // Get every distinct failed test on master in the past numHours (usually not a lot)
  const failedTests = await rocksetClient.queries.query({
    sql: {
      query: failedTestsQuery,
      parameters: [
        {
          name: "numHours",
          type: "int",
          value: numHours,
        },
      ],
    },
  });
  let failedTestsResults = failedTests.results ?? [];

  // For every failed test, query rockset for jobs that had file level reruns of
  // the test in the past numHours.  Do this separately because a join on
  // test_run_s3 takes a long time.  Batch the query since rockset doesn't allow
  // more tha 150 concurrent queries.  Flatten the accumulator since it ends up
  // being an array of arrays.
  let rerunTestsUnflattened: any[] = [];
  for (let i = 0; i < failedTestsResults.length; i += 25) {
    rerunTestsUnflattened.push(
      await Promise.all(
        failedTestsResults.slice(i, i + 25).map(async (e) => {
          const a = await rocksetClient.queries.query({
            sql: {
              query: checkEveryTestQuery,
              parameters: [
                {
                  name: "name",
                  type: "string",
                  value: e.name,
                },
                {
                  name: "classname",
                  type: "string",
                  value: e.classname,
                },
                {
                  name: "invoking_file",
                  type: "string",
                  value: e.invoking_file,
                },
                {
                  name: "file",
                  type: "string",
                  value: e.file,
                },
                {
                  name: "numHours",
                  type: "int",
                  value: numHours,
                },
              ],
            },
          });
          return a.results;
        })
      )
    );
  }
  const rerunTests = rerunTestsUnflattened.flat(2);

  // Query for info about the workflow job.  This could be done with the
  // previous query but I think this is less resource intense?
  const workflowJobInfo = await rocksetClient.queries.query({
    sql: {
      query: workflowJobInfoQuery,
      parameters: [
        {
          name: "job_ids",
          type: "string",
          value: rerunTests.map((e) => e.job_id).join(","),
        },
      ],
    },
  });

  const workflowJobMap = new Map(
    workflowJobInfo.results?.map((e) => [e.id, e])
  );
  const rerunTestsMap: Map<string, FlakyTestData> = rerunTests.reduce(
    (accum: Map<string, FlakyTestData>, curr) => {
      const key = `${curr.file} ${curr.suite} ${curr.name} ${curr.invoking_file}`;
      const val = accum.get(key);
      const job_info = workflowJobMap.get(curr.job_id);
      if (val === undefined) {
        accum.set(key, {
          file: curr.file,
          suite: curr.suite,
          name: curr.name,
          invoking_file: curr.invoking_file,
          numGreen: curr.numGreen,
          numRed: curr.numRed,
          workflowIds: [job_info.workflow_id],
          workflowNames: [job_info.workflow_name],
          jobIds: [curr.job_id],
          jobNames: [job_info.name],
          branches: [job_info.head_branch],
        });
      } else {
        val.jobIds.push(curr.job_id);
        val.numGreen += curr.numGreen;
        val.numRed += curr.numRed;
        val.workflowIds.push(job_info.workflow_id);
        val.workflowNames.push(job_info.workflow_name);
        val.jobNames.push(job_info.name);
        val.branches.push(job_info.head_branch);
      }
      return accum;
    },
    new Map()
  );

  return Array.from(rerunTestsMap.values());
}
