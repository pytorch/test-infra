import { queryClickhouseSaved } from "lib/clickhouse";
import {
  TimeSeriesDataPoint,
  TimeSeriesDbData,
  UtilizationAPIResponse,
  UtilizationMetadata,
  UtilizationParams,
} from "./types";

const DEFAULT_REPO = "pytorch/pytorch";
const UTIL_TS_QUERY_FOLDER_NAME = "oss_ci_util_ts";
const UTIL_METADATA_QUERY_FOLDER_NAME = "oss_ci_util_metadata";
const UTILIZATION_TYPE = "utilization";

export default async function fetchUtilization(
  params: UtilizationParams
): Promise<UtilizationAPIResponse | null> {
  const meta_resp: UtilizationMetadata[] = await getUtilizationMetadata(
    params.workflow_id,
    params.job_id,
    params.run_attempt
  );

  const metadata = getLatestMetadata(meta_resp);
  if (!metadata) {
    console.log(
      "No utilization metadata found for workflow_id: " +
        params.workflow_id +
        " job_id: " +
        params.job_id +
        " run_attempt: " +
        params.run_attempt +
        " type: " +
        UTILIZATION_TYPE
    );
    return null;
  }

  const test: UtilizationMetadata = metadata;

  const resp: TimeSeriesDbData[] = await getUtilTimesSeries(
    params.workflow_id,
    params.job_id,
    params.run_attempt,
    UTILIZATION_TYPE
  );
  const tsMap = flattenTS(resp);

  let tsList = [];
  for (const [key, value] of tsMap) {
    tsList.push({ name: key, value: value });
  }

  return {
    metadata: metadata,
    ts_list: tsList,
  };
}

// API methods
async function getUtilTimesSeries(
  workflow_id: string,
  job_id: string,
  run_attempt: string,
  type: string = "",
  from: string = "",
  to: string = ""
) {
  const response = await queryClickhouseSaved(UTIL_TS_QUERY_FOLDER_NAME, {
    workflowId: workflow_id,
    jobId: job_id,
    runAttempt: run_attempt,
    type: UTILIZATION_TYPE,
    repo: DEFAULT_REPO,
  });
  return response;
}

async function getUtilizationMetadata(
  workflow_id: string,
  job_id: string,
  run_attempt: string
) {
  const response = await queryClickhouseSaved(UTIL_METADATA_QUERY_FOLDER_NAME, {
    workflowId: workflow_id,
    jobId: job_id,
    runAttempt: run_attempt,
    type: UTILIZATION_TYPE,
    repo: DEFAULT_REPO,
  });
  return response;
}

function getLatestMetadata(
  items: UtilizationMetadata[]
): UtilizationMetadata | null {
  if (!items.length) return null;

  return items.reduce((latest, current) => {
    return new Date(latest.created_at) > new Date(current.created_at)
      ? latest
      : current;
  }, items[0]);
}

// Helper functions
/**
 * flatten nested timeseries data to form multiple timeseries list.
 * @param resp
 */
export function flattenTS(resp: TimeSeriesDbData[]) {
  let tsData = new Map<string, TimeSeriesDataPoint[]>();
  for (const re of resp) {
    if (!re.ts || !re.data) {
      continue;
    }
    const timestamp = re.ts;

    // convert json string to json object
    let data: any | null = toJson(re.data);
    if (!data) {
      continue;
    }

    // for each timestamp, flatten the json data input multiple time series point by category
    let dp: { name: string; value: number }[] = [];
    getDataPath(data, "", dp);

    dp.forEach((d) => {
      const li = tsData.get(d.name) || [];
      li.push({
        ts: timestamp,
        value: d.value,
      });
      if (!tsData.has(d.name)) {
        tsData.set(d.name, li);
      }
    });
  }
  return tsData;
}

/**
 * DFS throught nested object to form the name-path and stats value.
 * Example expected values {name: "gpu_usage|{gpu_uuid}|util_percent|avg", value: 20.1}
 * @param obj
 * @param path
 * @param res
 * @returns
 */
function getDataPath(
  obj: any,
  path: string,
  res: {
    name: string;
    value: number;
  }[]
) {
  if (!obj) {
    return;
  }

  if (checkType(obj) === "number") {
    res.push({ name: path, value: obj });
    return;
  }

  if (checkType(obj) == "array") {
    for (let idx = 0; idx < obj.length; idx++) {
      const nextObj = obj[idx];
      let next_path = formPath(path, `{idx}`);
      if (checkType(nextObj) == "object") {
        if (nextObj.uuid) {
          next_path = formPath(path, nextObj.uuid);
        }
      }
      getDataPath(nextObj, next_path, res);
    }
  }
  if (checkType(obj) === "object") {
    const keys = Object.keys(obj);
    for (const key of keys) {
      const el = obj[key];
      let nextP = formPath(path, key);
      getDataPath(el, nextP, res);
    }
  }
}

function checkType(item: any) {
  if (typeof item === "string") {
    return "string";
  } else if (Array.isArray(item)) {
    return "array";
  } else if (typeof item === "number") {
    return "number";
  } else if (typeof item === "object" && item !== null) {
    return "object";
  } else {
    return "unknown";
  }
}

function formPath(exist: string, addson: string) {
  if (exist == "") {
    return addson;
  }
  return `${exist}|${addson}`;
}

function toJson(data: string) {
  if (!data) {
    return null;
  }

  try {
    const jsonData = JSON.parse(data);
    return jsonData;
  } catch (error) {
    console.log(
      `Warning: Error parsing JSON:${error} for data string '${data}'`
    );
    return null;
  }
}
