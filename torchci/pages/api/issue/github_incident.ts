import { getErrorMessage } from "lib/error_utils";
import { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const response = await fetch(
      "https://www.githubstatus.com/api/v2/incidents/unresolved.json"
    );
    const data = await response.json();
    const latest = data.incidents?.[0] ?? null;
    return res.status(200).json({ latest });
  } catch (error) {
    const err_msg = getErrorMessage(error);
    console.log(err_msg);
    return res.status(500).json({ error: err_msg });
  }
}
