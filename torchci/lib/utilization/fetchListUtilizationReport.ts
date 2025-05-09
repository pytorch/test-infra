import { queryClickhouseSaved } from "lib/clickhouse";
import {
  EMPTY_LIST_UTILIZATION_SUMMARY_API_RESPONSE,
  ListUtilizationReportAPIResponse,
  ListUtilizationReportParams,
} from "./types";
const LIST_UTIL_REPORTS = "oss_ci_util/oss_ci_list_utilization_reports";

export default async function fetchListUtilizationReport(
  params: ListUtilizationReportParams
): Promise<ListUtilizationReportAPIResponse> {
  if (!params) {
    return EMPTY_LIST_UTILIZATION_SUMMARY_API_RESPONSE;
  }

  const resp = await ListUtilizationReport(params);

  if (!resp || resp.length == 0) {
    return EMPTY_LIST_UTILIZATION_SUMMARY_API_RESPONSE;
  }

  return {
    group_key: resp[0].groupKey,
    metadata_list: resp ? resp : [],
  };
}

async function ListUtilizationReport(params: any) {
  const response = await queryClickhouseSaved(LIST_UTIL_REPORTS, params);
  return response;
}
