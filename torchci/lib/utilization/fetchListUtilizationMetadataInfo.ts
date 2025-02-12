import { queryClickhouseSaved } from "lib/clickhouse";
import {
  ListUtilizationMetadataInfoAPIResponse,
  ListUtilizationMetadataInfoParams,
  UTILIZATION_DEFAULT_REPO,
  UtilizationMetadataInfo,
} from "./types";

export default async function fetchListUtilizationMetadataInfo(
  params: ListUtilizationMetadataInfoParams
): Promise<ListUtilizationMetadataInfoAPIResponse | null> {
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
  const response = await queryClickhouseSaved("oss_ci_util_metadata_info", {
    workflowId: workflow_id,
    repo: repo,
  });
  return response;
}
