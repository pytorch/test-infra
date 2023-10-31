import { Client } from "@opensearch-project/opensearch";
import { JobData } from "lib/types";

export const WORKFLOW_JOB_INDEX = "torchci-workflow-job";
// https://www.elastic.co/guide/en/elasticsearch/reference/7.17/similarity.html#similarity
// OpenSearch uses https://en.wikipedia.org/wiki/Okapi_BM25 by default.  TODO: learn more
// about which is a reasonable value here and how to tune it
export const MIN_SCORE = 1.0;
export const MAX_SIZE = 20;

export async function searchSimilarFailures(
  client: Client,
  query: string,
  workflowName: string,
  branchName: string,
  index: string,
  startDate: string,
  endDate: string,
  minScore: number,
  maxSize: number = MAX_SIZE
): Promise<{ jobs: JobData[] }> {
  const must: any[] = [
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
  ];
  // If specify, query by the workflow name too. This makes the query more
  // accurate for less frequent jobs like periodic or slow
  if (workflowName !== "") {
    must.push({
      match: {
        workflow_name: workflowName,
      },
    });
  }
  // If specify, limit the query to only this branch name. This is used to
  // query only failures from specific branches like main or release
  if (branchName !== "") {
    must.push({
      match: {
        head_branch: branchName,
      },
    });
  }

  const body = {
    min_score: minScore,
    size: maxSize,
    query: {
      bool: {
        must: must,
        // This limits the query to search only for failures, which are what we
        // care about
        must_not: [
          {
            match: {
              conclusion: "success",
            },
          },
        ],
      },
    },
    // NB: It's important to sort by score first so that the most relevant results
    // are at the top because we will only retrieve up to MAX_SIZE records
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
      failureLines: [data.torchci_classification.line],
      failureLineNumbers: [data.torchci_classification.line_num],
      failureCaptures: data.torchci_classification.captures,
      // NB: The author information, unfortunately, is not available atm in
      // torchci-workflow-job DynamoDB table. We might be able to update the
      // lambda to add it in the future though, but that's not a guarantee
      authorEmail: "",
    });
  });

  return { jobs: jobs };
}
