import { getErrorMessage } from "lib/error_utils";
import fetchUtilization from "lib/utilization/fetchUtilization";
import { UtilizationParams } from "lib/utilization/types";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "pages/api/auth/[...nextauth]";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { workflowId, jobId, attempt } = req.query;

  // @ts-ignore
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user || !session?.accessToken) {
    return res.status(401).json({
      error:
        "Authentication required to require utilization data, please login in the main hud page",
    });
  }

  if (!workflowId || !jobId || !attempt) {
    console.log(
      "[api job_utilization][warning] No workflowId, jobId, or attempt provided"
    );
    return res.status(200).json({});
  }

  const params: UtilizationParams = {
    workflow_id: workflowId as string,
    run_attempt: attempt as string,
    job_id: jobId as string,
  };

  try {
    // TODO: get better validation
    if (
      isNaN(parseInt(params.run_attempt)) ||
      isNaN(parseInt(params.workflow_id)) ||
      isNaN(parseInt(params.job_id))
    ) {
      return res
        .status(400)
        .json({ error: `Invalid parameters: ${JSON.stringify(params)}` });
    }

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
}
