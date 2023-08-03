import { Client } from "@opensearch-project/opensearch";
import { JobData } from "lib/types";

export async function searchSimilarFailures(
  client: Client,
  query: string,
  index: string,
  startDate: string,
  endDate: string,
  minScore: number
): Promise<{ jobs: JobData[] }> {
  const body = {
    min_score: minScore,
    query: {
      bool: {
        must: [
          {
            match: {
              "torchci_classification.line": query,
            },
          },
          {
            range: {
              completed_at: {
                gte: startDate,
                lte: endDate,
              },
            },
          },
        ],
      },
    },
    sort: [
      "_score",
      {
        completed_at: "desc",
      },
    ],
  };

  const response = await client.search({
    index: index,
    body: body,
  });

  const jobs: JobData[] = [];
  if (response === undefined) {
    return { jobs: jobs };
  }

  // Each record is a dictionary in the following format:
  // {
  //   _index: "torchci-workflow-job",
  //   _id: "pytorch/pytorch/15443494469",
  //   _score: 10.57254,
  //   _source: {
  //     ..The actual indexed document..
  //   }
  // }
  //
  // And no, the nested hits field is not a mistake
  response.body.hits.hits.forEach((record: any) => {
    const data = record._source;
    jobs.push({
      name: `${data.workflow_name} / ${data.name}`,
      workflowName: data.workflow_name,
      jobName: data.name,
      sha: data.head_sha,
      id: data.id,
      branch: data.head_branch,
      workflowId: data.run_id,
      time: data.completed_at,
      conclusion: data.conclusion,
      htmlUrl: data.html_url,
      failureLine: data.torchci_classification.line,
      failureLineNumber: data.torchci_classification.line_num,
      failureCaptures: data.torchci_classification.captures,
    });
  });
  return { jobs: jobs };
}
