import { getErrorMessage } from "lib/error_utils";
import fetchListUtilizationSummary from "lib/utilization/fetchListUtilizationReport";
import {
  EMPTY_LIST_UTILIZATION_METADATA_INFO_API_RESPONSE,
  ListUtilizationReportParams,
} from "lib/utilization/types";
import { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
<<<<<<< HEAD
<<<<<<< HEAD
  const { repo, group_by, granularity, start_time, end_time } = req.query;
=======
  const { repo, group_by, granularity , start_time , end_time  } = req.query;
>>>>>>> 7950c7df4 (add model test1)
=======
  const { repo, group_by, granularity, start_time, end_time } = req.query;
>>>>>>> d70a55bb0 (add model test1)

  const p: ListUtilizationReportParams = {
    repo: repo as string,
    group_by: group_by as string,
    start_time: start_time as string,
    end_time: end_time as string,
    granularity: granularity as string,
  };

  try {
    const resp = await fetchListUtilizationSummary(p);
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
