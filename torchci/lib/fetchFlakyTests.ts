import { queryClickhouse, queryClickhouseSaved } from "./clickhouse";
import { FlakyTestData } from "./types";

export default async function fetchFlakyTests(
  numHours: string = "3",
  testName: string = "%",
  testSuite: string = "%",
  testFile: string = "%"
): Promise<FlakyTestData[]> {
  return queryClickhouseSaved("flaky_tests", {
    numHours,
    name: testName,
    suite: testSuite,
    file: testFile,
  });
}

export async function fetchFlakyTestsAcrossJobs(): Promise<FlakyTestData[]> {
  // Not currently used, see
  // https://github.com/pytorch/test-infra/blob/228e62e647fb74d092b809f7f34dee84c9ba461e/torchci/lib/fetchFlakyTests.ts#L44
  // for the implementation
  return [];
}

export async function fetchFlakyTestsAcrossFileReruns(
  numHours: string = "3"
): Promise<FlakyTestData[]> {
  const failedTestsQuery = `
with jobs as (
  select id
  from materialized_views.workflow_job_by_completed_at
  where completed_at > (CURRENT_TIMESTAMP() - interval {numHours: Int64} hour)
)
select
  DISTINCT
  name,
  file,
  invoking_file,
  classname
from
  default.test_run_s3
where
  (
    LENGTH(failure) != 0
    or LENGTH(error) != 0
  )
  and file != ''
  and job_id in (select id from jobs)
`;

  const checkEveryTestQuery = `
with jobs as (
  select id
  from materialized_views.workflow_job_by_completed_at
  where completed_at > (CURRENT_TIMESTAMP() - interval {numHours: Int64} hour)
)
select
    name,
    classname as suite,
    file,
    invoking_file,
    job_id,
    1 as numGreen,
    SUM(LENGTH(rerun)) as numRed,
    any(rerun[1].'text') as sampleTraceback
FROM
    default.test_run_s3
where
    name = {name: String}
    and classname = {classname: String}
    and invoking_file = {invoking_file: String}
    and file = {file: String}
    and job_id in (select id from jobs)
    and LENGTH(skipped) = 0
GROUP BY
    name,
    suite,
    file,
    invoking_file,
    job_id
HAVING
    MIN(LENGTH(failure)) = 0
    and MAX(LENGTH(failure) + LENGTH(error)) != 0
`;

  const workflowJobInfoQuery = `
with jobs as (
  select
    name,
    id,
    run_id,
    run_attempt,
    html_url
  from default.workflow_job final
  where
    id in {job_ids: Array(Int64)}
    and name not like '%rerun_disabled_tests%'
)
select
  j.name as name,
  w.name as workflow_name,
  j.id as id,
  w.id as workflow_id,
  w.head_branch as head_branch,
  j.run_attempt as run_attempt,
  j.html_url as html_url
from
  default.workflow_run w final join jobs j on w.id = j.run_id
where
  w.id in (select run_id from jobs)
`;

  // Get every distinct failed test on master in the past numHours (usually not a lot)
  const failedTestsResults = await queryClickhouse(failedTestsQuery, {
    numHours,
  });

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
          return await queryClickhouse(checkEveryTestQuery, {
            name: e.name,
            classname: e.classname,
            invoking_file: e.invoking_file,
            file: e.file,
            numHours,
          });
        })
      )
    );
  }
  const rerunTests = rerunTestsUnflattened.flat(2);

  // Query for info about the workflow job.  This could be done with the
  // previous query but I think this is less resource intense?
  const workflowJobInfo = await queryClickhouse(workflowJobInfoQuery, {
    job_ids: rerunTests.map((e) => e.job_id),
  });

  const workflowJobMap = new Map(workflowJobInfo.map((e) => [e.id, e]));
  const rerunTestsMap: Map<string, FlakyTestData> = rerunTests.reduce(
    (accum: Map<string, FlakyTestData>, curr) => {
      const key = `${curr.file} ${curr.suite} ${curr.name} ${curr.invoking_file}`;
      const val = accum.get(key);
      if (!workflowJobMap.has(curr.job_id)) {
        return accum;
      }
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
          sampleTraceback: curr.sampleTraceback,
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
