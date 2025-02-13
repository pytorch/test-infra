import { getErrorMessage } from "lib/error_utils";
import fetchListUtilizationMetadataInfo from "lib/utilization/fetchListUtilizationMetadataInfo";
import {
  ListUtilizationMetadataInfoAPIResponse,
  ListUtilizationMetadataInfoParams,
} from "lib/utilization/types";
import { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { workflowId } = req.query;

  // swr hook will call this api with empty query, return empty object

  if (!workflowId) {
    const emptyResp: ListUtilizationMetadataInfoAPIResponse = {
      metadata_list: [],
    };
    return res.status(200).json(emptyResp);
  }

  const params: ListUtilizationMetadataInfoParams = {
    workflow_id: workflowId as string,
  };

  try {
    const resp = await fetchListUtilizationMetadataInfo(params);

    if (!resp) {
      const emptyResp: ListUtilizationMetadataInfoAPIResponse = {
        metadata_list: [],
      };
      return res.status(200).json(emptyResp);
    }
    return res.status(200).json(resp);
  } catch (error) {
    const err_msg = getErrorMessage(error);
    return res.status(500).json({ error: err_msg });
  }
}
