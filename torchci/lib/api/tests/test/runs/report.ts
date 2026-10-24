import {
  RunAttempt,
  RunCatalogRecord,
  RunWorkflowFields,
} from "lib/api/tests/test/runs/types";

export function runReport(
  run: Pick<
    RunCatalogRecord,
    "report_uuid" | "github_workflow_job_id" | "test"
  >,
  workflow: Pick<RunWorkflowFields, "github_workflow_run_id">
): RunAttempt["report"] {
  const { report_uuid: uuid, github_workflow_job_id: jobId, test } = run;
  const runId = workflow.github_workflow_run_id;
  const report = { uuid, s3_url: null };
  if (
    !test ||
    !runId ||
    !/^[1-9]\d*$/.test(runId) ||
    !/^[1-9]\d*$/.test(jobId) ||
    !/^[\w.-]+\/[\w.-]+$/.test(test.repo) ||
    uuid === "00000000-0000-0000-0000-000000000000"
  ) {
    return report;
  }

  // Mirror common_utils.sanitize_test_filename and run_test's report prefixes:
  // Python paths are relative to test/, while C++ paths keep cpp/.
  const file =
    test.language === "python" && /^test\/.+\.py$/.test(test.file)
      ? test.file.slice("test/".length, -".py".length)
      : test.language === "cpp" && /^cpp\/[^/]+$/.test(test.file)
      ? test.file
      : null;
  const prefix = file?.replace(/\//g, ".");
  if (!prefix || !/^[\w.-]+$/.test(prefix)) return report;

  // upload-test-artifacts and upload_artifacts.py use the same object key.
  return {
    uuid,
    s3_url: `https://gha-artifacts.s3.amazonaws.com/torchci-reports/${test.repo}/${runId}/${jobId}/${prefix}-${uuid}.report.jsonl`,
  };
}
