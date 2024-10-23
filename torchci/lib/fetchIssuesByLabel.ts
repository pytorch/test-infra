import { queryClickhouseSaved } from "./clickhouse";
import { IssueData } from "./types";

export default async function fetchIssuesByLabel(
  label: string
): Promise<IssueData[]> {
  return await queryClickhouseSaved("issue_query", {
    label,
  });
}
