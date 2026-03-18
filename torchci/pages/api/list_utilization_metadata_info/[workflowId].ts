import { getErrorMessage } from "lib/error_utils";
import fetchListUtilizationMetadataInfo from "lib/utilization/fetchListUtilizationMetadataInfo";
import {
  EMPTY_LIST_UTILIZATION_METADATA_INFO_API_RESPONSE,
  ListUtilizationMetadataInfoParams,
} from "lib/utilization/types";
import { NextApiRequest, NextApiResponse } from "next";

// API list_utilization_metadata_info/[workflowId]
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { workflowId, includes_stats } = req.query;

  // swr hook will call this api with empty query, return empty object
  if (!workflowId) {
    return res
      .status(200)
      .json(EMPTY_LIST_UTILIZATION_METADATA_INFO_API_RESPONSE);
  }

  const params: ListUtilizationMetadataInfoParams = {
    workflow_id: workflowId as string,
    include_stats: includes_stats == "true",
  };

  try {
    const resp = await fetchListUtilizationMetadataInfo(params);
    if (!resp) {
      return res
        .status(200)
        .json(EMPTY_LIST_UTILIZATION_METADATA_INFO_API_RESPONSE);
    }
    return res.status(200).json(resp);
  } catch (error) {
    const err_msg = getErrorMessage(error);
    return res.status(500).json({ error: err_msg });
  }
}
