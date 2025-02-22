import { queryClickhouseSaved } from "./clickhouse";
import { FlakyTestData } from "./types";

export default async function fetchFlakyTests(
  numHours: string = "3",
  testName: string = "%",
  testSuite: string = "%",
  testFile: string = "%"
): Promise<FlakyTestData[]> {
  return queryClickhouseSaved("flaky_tests/in_subprocess", {
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
  // Get every distinct failed test on master in the past numHours (usually not a lot)
  const failedTestsResults = await queryClickhouseSaved(
    "flaky_tests/across_file_reruns/failed_tests",
    {
      numHours,
    }
  );

  // For every failed test, query the database for jobs that had file level reruns of
  // the test in the past numHours.  Do this separately because a join on
  // test_run_s3 takes a long time.  Batch the query since rockset doesn't allow
  // more tha 150 concurrent queries.  Flatten the accumulator since it ends up
  // being an array of arrays.
  // TODO: Check if batching is still needed now that we are using clickhouse
  let rerunTestsUnflattened: any[] = [];
  for (let i = 0; i < failedTestsResults.length; i += 25) {
    rerunTestsUnflattened.push(
      await Promise.all(
        failedTestsResults.slice(i, i + 25).map(async (e) => {
          return await queryClickhouseSaved(
            "flaky_tests/across_file_reruns/check_every_test",
            {
              name: e.name,
              classname: e.classname,
              invoking_file: e.invoking_file,
              file: e.file,
              numHours,
            }
          );
        })
      )
    );
  }
  const rerunTests = rerunTestsUnflattened.flat(2);

  // Query for info about the workflow job.  This could be done with the
  // previous query but I think this is less resource intense?
  const workflowJobInfo = await queryClickhouseSaved(
    "flaky_tests/across_file_reruns/workflow_job_info",
    {
      job_ids: rerunTests.map((e) => e.job_id),
    }
  );

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
