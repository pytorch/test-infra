import { toBenchmarkTimeSeriesReponseFormat } from "../../common/utils";

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
 * @param rawData
 * @param inputparams
 * @param type
 */
export function toGeneralCompilerData(
  rawData: any[],
  formats: string[] = ["time_series"]
) {
  const config = COMPILER_GROUP_MAP;
  return toBenchmarkTimeSeriesReponseFormat(rawData, config, formats);
}
