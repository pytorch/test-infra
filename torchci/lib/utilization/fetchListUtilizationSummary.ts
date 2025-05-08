import { queryClickhouseSaved } from "lib/clickhouse";
import {
  EMPTY_LIST_UTILIZATION_SUMMARY_API_RESPONSE,
  ListUtilizationSummaryAPIResponse,
  ListUtilizationSummaryParams,
  UTILIZATION_DEFAULT_REPO,
} from "./types";
const LIST_UTIL_SUMMARY = "oss_ci_util/oss_ci_list_util_summary";

export default async function fetchListUtilizationSummary(
  params: ListUtilizationSummaryParams
): Promise<ListUtilizationSummaryAPIResponse> {
  if (!params) {
    return EMPTY_LIST_UTILIZATION_SUMMARY_API_RESPONSE;
  }

  const resp = await listUtilizationSummary(
    params.repo,
    params.groupBy,
    params.granularity,
    params.startTime,
    params.endTime
  );

  if (!resp || resp.length == 0) {
    return EMPTY_LIST_UTILIZATION_SUMMARY_API_RESPONSE;
  }

  return {
    group_key: resp[0].groupKey,
    metadata_list: resp ? resp : [],
  };
}

async function listUtilizationSummary(
  repo: string = UTILIZATION_DEFAULT_REPO,
  groupBy: string = "workflow_name",
  granularity: string = "day",
  startTime?: string,
  endTime?: string
) {
  const response = await queryClickhouseSaved(LIST_UTIL_SUMMARY, {
    repo,
    groupBy,
    granularity,
    startTime,
    endTime,
  });
  return response;
}
