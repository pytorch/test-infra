import { queryClickhouseSaved } from "./clickhouse";
import { IssueData } from "./types";

export default async function fetchIssuesByLabel(
  label: string,
  useChCache?: boolean
): Promise<IssueData[]> {
  return await queryClickhouseSaved(
    "issue_query",
    {
      label,
    },
    useChCache
  );
}
