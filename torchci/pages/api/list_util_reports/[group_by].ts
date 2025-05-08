import { getErrorMessage } from "lib/error_utils";
import fetchListUtilizationSummary from "lib/utilization/fetchListUtilizationSummary";
import {
  EMPTY_LIST_UTILIZATION_METADATA_INFO_API_RESPONSE,
  ListUtilizationSummaryParams,
} from "lib/utilization/types";
import { NextApiRequest, NextApiResponse } from "next";

// API list_utilization_metadata_info/[workflowId]
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { repo, group_by, start_time, granularity, end_time } = req.query;

  // swr hook will call this api with empty query, return empty object
  if (!repo || !group_by || !start_time || !end_time) {
    return res
      .status(200)
      .json(EMPTY_LIST_UTILIZATION_METADATA_INFO_API_RESPONSE);
  }

  const params: ListUtilizationSummaryParams = {
    repo: repo as string,
    groupBy: group_by as string,
    startTime: start_time as string,
    endTime: end_time as string,
    granularity: granularity as string,
  };

  try {
    const resp = await fetchListUtilizationSummary(params);
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
