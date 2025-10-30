import { toBenchmarkTimeSeriesReponseFormat } from "../../common/utils";
import _ from "lodash";

const COMPILER_GENERAL_TS_GROUP_KEY = [
  "dtype",
  "arch",
  "device",
  "suite",
  "compiler",
  "metric",
  "mode",
  "model",
  "branch",
];
const COMPILER_GENERAL_TS_SUB_GROUP_KEY = ["workflow_id"];

const COMPILER_GENERAL_TABLE_GROUP_KEY = [
  "dtype",
  "arch",
  "device",
  "mode",
  "workflow_id",
  "branch",
  "compiler",
  "model",
  "suite",
];
const COMPILER_GENERAL_TABLE_SUB_GROUP_KEY = ["metric"];

export const COMPILER_GROUP_MAP = {
  time_series: {
    group_key: COMPILER_GENERAL_TS_GROUP_KEY,
    sub_group_key: COMPILER_GENERAL_TS_SUB_GROUP_KEY,
  },
  table: {
    group_key: COMPILER_GENERAL_TABLE_GROUP_KEY,
    sub_group_key: COMPILER_GENERAL_TABLE_SUB_GROUP_KEY,
  },
};

/**
 * process general compiler data without precompute or aggregation
 * This includes post process metrics such as accurancy
 * @param rawData
 * @param inputparams
 * @param type
 */
export function toGeneralCompilerData(
  rawData: any[],
  formats: string[] = ["time_series"]
) {
  const config = COMPILER_GROUP_MAP;

  const normalized = normalizeBenchmarkValues(rawData);
  return toBenchmarkTimeSeriesReponseFormat(normalized, config, formats);
}


function normalizeBenchmarkValues(rows: any[]) {
  return rows.map((row) => {
    if (row.metric === "accuracy" && _.get(row, "extra_info.benchmark_values")) {
      try {
        const parsed = JSON.parse(_.get(row, "extra_info.benchmark_values"));
        if (Array.isArray(parsed) && parsed.length > 0) {
          return { ...row, value: parsed[0], value_type: "string"};
        }
      } catch {
        // ignore JSON parse errors
      }
    }
    return row;
  });
}
