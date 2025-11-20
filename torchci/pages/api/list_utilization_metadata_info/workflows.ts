import { readApiGetParams } from "lib/benchmark/api_helper/backend/common/utils";
import { getErrorMessage } from "lib/error_utils";
import { listUtilizationMetadataInfo } from "lib/utilization/fetchListUtilizationMetadataInfo";
import { EMPTY_LIST_WORKFLOWS_UTILIZATION_METADATA_INFO_API_RESPONSE } from "lib/utilization/types";
import { NextApiRequest, NextApiResponse } from "next";

/**
 * API Route: /api/list_utilization_metadata/workflows
 *  Fetch benchmark time series data (e.g., compiler performance).
 *  currently only support compiler_precompute
 *
 * Supported Methods:
 *   - GET  : Pass parameters via query string
 *            Example:
 *              /api/list_utilization_metadata/workflows?parameters={repo:"pytorch/pytorch", workflow_ids:["f1234567890"]}
 *   - POST : Pass parameters in JSON body
 *            Example:
 *              {
 *
 *                    repo: string,
 *                    workflow_ids: Array<string>,
 *              }
 **/
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Only GET and POST allowed" });
  }
  const params = readApiGetParams(req);
  console.log("[API]list_utilization_metadata_info/workflows, received request:", params);

  // validate params
  if (
    !params ||
    !params.query_params ||
    Object.keys(params).length == 0) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  if (!params.workflow_ids || params.workflow_ids.length == 0 || !params.repo) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    const resp = await fetchListUtilizationMetadataInfoForWorkflows(params);
    if (!resp) {
      return res
        .status(200)
        .json(EMPTY_LIST_WORKFLOWS_UTILIZATION_METADATA_INFO_API_RESPONSE);
    }
    return res.status(200).json(resp);
  } catch (error) {
    const err_msg = getErrorMessage(error);
    console.error("[API]list_utilization_metadata_info/workflows, error: ", err_msg)
    return res.status(500).json({ error: err_msg });
  }
}



export async function fetchListUtilizationMetadataInfoForWorkflows(
  params: any
): Promise<any> {
  let workflowIds = []
  if (params.workflow_id){
    workflowIds = [params.workflow_id]
  } else if (params.workflow_ids){
    workflowIds = params.workflow_ids
  }
  let repos = [params.repo]
  const meta_resp = await listUtilizationMetadataInfo(
      workflowIds,
      repos
    );

  if (!meta_resp || meta_resp.length == 0) {
    return EMPTY_LIST_WORKFLOWS_UTILIZATION_METADATA_INFO_API_RESPONSE;
  }
  return {
    metadata_map:
  };
}
