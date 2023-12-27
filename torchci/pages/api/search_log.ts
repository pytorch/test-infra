import { retryRequest } from "lib/bot/utils";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // This might be expensive?
  const query = req.query.query as string;
  const jobIds = (req.query.jobIds as string).split(",");
  if (query == "") {
    res.status(200).json({});
    return;
  }
  const results: [string, number[][] | undefined][] = await Promise.all(
    jobIds.map(async (jobId) => {
      return [jobId, await searchLog(jobId, query)];
    })
  );
  res.status(200).json(Object.fromEntries(new Map(results)));
}

async function searchLog(jobId: string, query: string) {
  try {
    const result = await retryRequest(
      `https://ossci-raw-job-status.s3.amazonaws.com/log/${jobId}`
    );
    if (result.res.statusCode != 200) {
      return undefined;
    }
    const lineNumbers = [];
    const lineTexts = [];
    const threshold = 100;
    for (const [index, line] of result.data.toString().split("\n").entries()) {
      if (RegExp(query).test(line)) {
        lineNumbers.push(index);
        lineTexts.push(
          line.length > 100 ? `${line.substring(0, 100)}...` : line
        );
        if (lineNumbers.length >= threshold) {
          break;
        }
      }
    }
    return [lineNumbers, lineTexts];
  } catch (error) {
    console.log(error);
    return [];
  }
}
