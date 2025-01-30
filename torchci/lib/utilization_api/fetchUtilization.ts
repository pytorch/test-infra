import { queryClickhouseSaved } from "lib/clickhouse";
import { TimeSeriesDbData, UtilizationAPIResponse, UtilizationMetadata, UtilizationParams } from "./types";

const DEFAULT_REPO = "pytorch/pytorch";
const UTIL_TS_QUERY_FOLDER_NAME = "oss_ci_util_ts";
const UTIL_METADATA_QUERY_FOLDER_NAME = "oss_ci_util_metadata"

async function getUtilTimesSeries(
  workflow_id: number,
  job_id: number,
  run_attempt: number,
  type:string,
  from:string = "",
  to: string = "") {
    const response = await queryClickhouseSaved(UTIL_TS_QUERY_FOLDER_NAME, {
      workflowId: workflow_id,
      jobId: job_id,
      runAttempt: run_attempt,
      type: type,
      repo: DEFAULT_REPO,
    });
    return response;
  }

async function getUtilizationMetadata(
  workflow_id: number,
  job_id: number,
  run_attempt: number,
  type:string){
  const response = await queryClickhouseSaved(UTIL_METADATA_QUERY_FOLDER_NAME, {
    workflowId: workflow_id,
    jobId: job_id,
    runAttempt: run_attempt,
    type: type,
    repo: DEFAULT_REPO,
  });
  return response;
}

function getLatestMetadata(items: UtilizationMetadata[]): UtilizationMetadata | null {
  if (!items.length) return null;
  return items.reduce((latest, current) => {
    return new Date(latest.created_at) > new Date(current.created_at) ? latest : current;
  }, items[0]);
}

export default async function fetchUtilization(
  params: UtilizationParams
): Promise<UtilizationAPIResponse> {

  const meta_resp = await getUtilizationMetadata(params.workflow_id,
    params.job_id,
    params.run_attempt,
    params.type,
  )
  const metadata = getLatestMetadata(meta_resp)
  if (!metadata) {
    console.log("No util metadata found for workflow_id: " + params.workflow_id + " job_id: " + params.job_id + " run_attempt: " + params.run_attempt + " type: " + params.type);
    return {};
  }

  const response = await getUtilTimesSeries(
    params.workflow_id,
    params.job_id,
    params.run_attempt,
    params.type,
  );
  let results = response as TimeSeriesDbData[];

   results.map((re) => {
    
   });


  return {};
}
