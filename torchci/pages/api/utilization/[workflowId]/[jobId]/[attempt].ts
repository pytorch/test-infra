<<<<<<< HEAD
import { getErrorMessage } from "lib/error_utils";
=======
>>>>>>> fac729a89 (test)
import fetchUtilization from "lib/utilization/fetchUtilization";
import { UtilizationParams } from "lib/utilization/types";
import { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { workflowId, jobId, attempt } = req.query;
  if (workflowId === undefined || jobId === undefined || attempt == undefined) {
    return res.status(200).json({});
<<<<<<< HEAD
  }
  const params: UtilizationParams = {
    workflow_id: workflowId as string,
    run_attempt: attempt as string,
    job_id: jobId as string,
  };

  try {
    const utilData = await fetchUtilization(params);
    if (utilData == null) {
      return res
        .status(404)
        .json({ error: `No data found for params ${JSON.stringify(params)}` });
    }
    return res.status(200).json(utilData);
  } catch (error) {
    const err_msg = getErrorMessage(error);
    return res.status(500).json({ error: err_msg });
  }
=======
  }
  const params: UtilizationParams = {
    workflow_id: workflowId as string,
    run_attempt: attempt as string,
    job_id: jobId as string,
  };

  const utilData = await fetchUtilization(params);
  if (utilData == null) {
    return res.status(200).json({});
  }
  return res.status(200).json(utilData);
>>>>>>> fac729a89 (test)
}
