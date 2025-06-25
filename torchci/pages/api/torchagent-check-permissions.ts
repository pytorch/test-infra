import { NextApiRequest, NextApiResponse } from "next";
import { getAuthorizedUsername } from "../../lib/getAuthorizedUsername";
import { authOptions } from "./auth/[...nextauth]";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Only allow GET method
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const username = await getAuthorizedUsername(req, res, authOptions);
  if (!username) {
    // getAuthorizedUsername already sent the appropriate error response
    return;
  }

  // If we get here, the user has sufficient permissions
  res.status(200).json({
    authorized: true,
    username: username === "grafana-bypass-user" ? "system" : username,
  });
}
