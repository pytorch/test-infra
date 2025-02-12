import { getErrorMessage } from "lib/error_utils";
import fetchListUtilizationMetadataInfo from "lib/utilization/fetchListUtilizationMetadataInfo";
import { ListUtilizationMetadataInfoParams } from "lib/utilization/types";
import { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { workflowId } = req.query;
  if (!workflowId) {
    return res.status(400).json({ error: "workflowId is required" });
  }

  const params: ListUtilizationMetadataInfoParams = {
    workflow_id: workflowId as string,
  };

  try {
    const resp = await fetchListUtilizationMetadataInfo(params);
    if (resp == null) {
      return res
        .status(404)
        .json({ error: `No data found for params ${JSON.stringify(params)}` });
    }
    return res.status(200).json(resp);
  } catch (error) {
    const err_msg = getErrorMessage(error);
    return res.status(500).json({ error: err_msg });
  }
}
