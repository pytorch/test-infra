// For a given workflow id and sha, finds a corresponding workflow on the sha
// and returns its workflow id.  For example, if the workflow id is 123 and is
// the trunk workflow, then this will return the workflow id for the trunk
// workflow on the provided sha

import type { NextApiRequest, NextApiResponse } from "next";
import getRocksetClient, { RocksetParam } from "lib/rockset";

async function getCorrespondingWorkflowID(sha: string, workflowId: string) {
  const parameters: RocksetParam[] = [
    { name: "sha", type: "string", value: sha },
    { name: "workflow_id", type: "int", value: workflowId },
  ];

  const query = `
select
    w2.id
from
    workflow_run w1
    join workflow_run w2 on w1.workflow_id = w2.workflow_id
where
    w1.id = :workflow_id
    and w2.head_sha = :sha
order by w2.id desc
`;

  const client = getRocksetClient();
  const results = await client.queries.query({
    sql: {
      query,
      parameters,
    },
  });
  return results.results;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const sha = req.query.sha as string;
  const workflowId = req.query.workflowId as string;

  res.status(200).json(await getCorrespondingWorkflowID(sha, workflowId));
}
