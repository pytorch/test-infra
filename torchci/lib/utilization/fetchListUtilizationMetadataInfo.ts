import { queryClickhouseSaved } from "lib/clickhouse";
import {
  ListUtilizationMetadataInfoAPIResponse,
  ListUtilizationMetadataInfoParams,
  UTILIZATION_DEFAULT_REPO,
  UtilizationMetadataInfo,
} from "./types";
const LIST_UTIL_METADATA_INFO_QUERY_FOLDER_NAME =
  "oss_ci_list_util_metadata_info";

export default async function fetchListUtilizationMetadataInfo(
  params: ListUtilizationMetadataInfoParams
): Promise<ListUtilizationMetadataInfoAPIResponse> {
  const meta_resp = await getUtilizationMetadataInfo(
    params.workflow_id,
    params.repo
  );

  return {
    metadata_list: meta_resp ? meta_resp : ([] as UtilizationMetadataInfo[]),
  };
}

async function getUtilizationMetadataInfo(
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
