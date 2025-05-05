import { queryClickhouseSaved } from "lib/clickhouse";
import {
  EMPTY_LIST_UTILIZATION_METADATA_INFO_API_RESPONSE,
  ListUtilizationMetadataInfoAPIResponse,
  ListUtilizationMetadataInfoParams,
  UTILIZATION_DEFAULT_REPO,
  UtilizationAggreStats,
  UtilizationMetadataInfo,
} from "./types";
const LIST_UTIL_METADATA_INFO_QUERY_FOLDER_NAME =
  "oss_ci_list_util_metadata_info";
const LIST_UTIL_METADATA_WITH_STATS_QUERY = "oss_ci_list_util_stats";

export default async function fetchListUtilizationMetadataInfo(
  params: ListUtilizationMetadataInfoParams
): Promise<ListUtilizationMetadataInfoAPIResponse> {
  let meta_resp = null;
  if (params.include_stats) {
    meta_resp = await listUtilizationMetadataWithStats(
      params.workflow_id,
      params.repo
    );
  } else {
    meta_resp = await listUtilizationMetadataInfo(
      params.workflow_id,
      params.repo
    );
  }

  if (!meta_resp || meta_resp.length == 0) {
    return EMPTY_LIST_UTILIZATION_METADATA_INFO_API_RESPONSE;
  }

  return {
    workflow_id: params.workflow_id,
    workflow_name: meta_resp[0].workflow_name,
    metadata_list: meta_resp ? meta_resp : ([] as UtilizationMetadataInfo[]),
  };
}

async function listUtilizationMetadataInfo(
  workflow_id: string,
  repo: string = UTILIZATION_DEFAULT_REPO
) {
  const response = await queryClickhouseSaved(
    LIST_UTIL_METADATA_INFO_QUERY_FOLDER_NAME,
    {
      workflowId: workflow_id,
      repo: repo,
    }
  );
  return response;
}

async function listUtilizationMetadataWithStats(
  workflow_id: string,
  repo: string = UTILIZATION_DEFAULT_REPO
) {
  const response = await queryClickhouseSaved(
    LIST_UTIL_METADATA_WITH_STATS_QUERY,
    {
      workflowId: workflow_id,
      repo: repo,
    }
  );

  let res = [];
  for (const metadata of response) {
    const data = toMetadata(metadata);
    data.stats = toUtilizationStats(metadata);
    res.push(data);
  }
  return res;
}
function toMetadata(metadata: any) {
  const data: UtilizationMetadataInfo = {
    workflow_id: metadata.workflow_id,
    workflow_name: metadata.workflow_name,
    repo: metadata.repo,
    job_name: metadata.job_name,
    job_id: metadata.job_id,
    run_attempt: metadata.run_attempt,
  };
  return data;
}
function toUtilizationStats(metadata: any) {
  const stats: UtilizationAggreStats = {
    cpu_max: metadata.cpu_max,
    cpu_avg: metadata.cpu_avg,
    cpu_p90: metadata.cpu_p90,
    memory_max: metadata.memory_max,
    memory_avg: metadata.memory_avg,
    memory_p90: metadata.memory_p90,
    gpu_max: metadata.gpu_count ? metadata.gpu_max : undefined,
    gpu_avg: metadata.gpu_count ? metadata.gpu_avg : undefined,
    gpu_p90: metadata.gpu_count ? metadata.gpu_p90 : undefined,
    gpu_memory_max: metadata.gpu_count ? metadata.gpu_mem_max : undefined,
    gpu_memory_avg: metadata.gpu_count ? metadata.gpu_mem_avg : undefined,
    gpu_memmory_p90: metadata.gpu_count ? metadata.gpu_mem_p90 : undefined,
    has_gpu: metadata.gpu_count ? metadata.gpu_count > 0 : false,
  };
  return stats;
}
