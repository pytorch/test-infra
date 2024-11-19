// For a given workflow id and sha, finds a corresponding workflow on the sha
// and returns its workflow id.  For example, if the workflow id is 123 and is
// the trunk workflow, then this will return the workflow id for the trunk
// workflow on the provided sha

import { queryClickhouse } from "lib/clickhouse";
import type { NextApiRequest, NextApiResponse } from "next";

async function getCorrespondingWorkflowID(sha: string, workflowId: string) {
  const query = `
select
    w2.id as id
from
    -- Not bothering with final since ids and shas shouldn't change
    default.workflow_run w1
    join default.workflow_run w2 on w1.workflow_id = w2.workflow_id
where
    w1.id = {workflow_id: Int64}
    and w2.head_sha = {sha: String}
order by w2.id desc
`;

  return await queryClickhouse(query, {
    workflow_id: workflowId,
    sha: sha,
  });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const sha = req.query.sha as string;
  const workflowId = req.query.workflowId as string;

  res.status(200).json(await getCorrespondingWorkflowID(sha, workflowId));
}
