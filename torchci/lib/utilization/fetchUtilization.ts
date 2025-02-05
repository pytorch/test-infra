import { queryClickhouseSaved } from "lib/clickhouse";
import { truncate, map, sortBy } from "lodash";
import {
  Metrics,
  MetricType,
  TimeSeriesDataPoint,
  TimeSeriesDbData,
  TimeSeriesObject,
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

  const resp: TimeSeriesDbData[] = await getUtilTimesSeries(
    params.workflow_id,
    params.job_id,
    params.run_attempt
  );
  const tsMap = flattenTS(resp);

  let tsList: TimeSeriesObject[] = [];
  for (const [key, value] of tsMap) {
    const displayname = getTimeSeriesDisplayName(key);
    tsList.push({ name: key, displayname: displayname, records: value });
  }

  let hardware_metrics : Metrics[] = [];
  for (const tso of tsList) {
    const new_metrics = getTimeSeriesMetrics(tso);
    hardware_metrics = [...hardware_metrics, ...new_metrics];
  }

  return {
    metadata: metadata,
    ts_list: tsList,
    hardware_metrics: hardware_metrics,
  };
}


async function getUtilTimesSeries(
  workflow_id: string,
  job_id: string,
  run_attempt: string
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

function getTimeSeriesMetrics(tso: TimeSeriesObject): Metrics[] {
  if (tso.records.length == 0) return [];
  const res: Metrics[] = [];
  const mean =
    tso.records.reduce((acc, current) => acc + current.value, 0) /
    tso.records.length;
  const mm: Metrics = {
    displayname: tso.displayname,
    name: tso.name,
    value: Number(mean.toFixed(2)),
    metric: MetricType.AVERAGE,
    unit: "%",
  };

  res.push(mm);

  const p90m = calculatePercentile(tso.records,90)
  if (p90m != -1){
    const mdat90: Metrics = {
    displayname: tso.displayname,
    name: tso.name,
    value: Number(p90m.toFixed(2)),
    metric: MetricType.PERCENTILE_90TH,
    unit: "%",
  };
  res.push(mdat90);
  }

  const p50m = calculatePercentile(tso.records,50)
  if (p50m != -1){
    const mdat50: Metrics = {
    displayname: tso.displayname,
    name: tso.name,
    value: Number(p50m.toFixed(2)),
    metric: MetricType.PERCENTILE_50TH,
    unit: "%",
  };
  res.push(mdat50);
  }

  return res;
}

function calculatePercentile(data: TimeSeriesDataPoint[], threshold: number) {
  if (data.length == 0) return -1; // No data
  const values = map(data, 'value');
  const sortedValues = sortBy(values);
  let index = Math.floor(sortedValues.length * (threshold / 100));
  if (index < 0){
    index = 0;
  }
  if(index >= sortedValues.length) {
    index = sortedValues.length - 1;
  }
  return sortedValues[index];
}

function getTimeSeriesDisplayName(name: string) {
  const splited = name.split("|");
  if (splited.length <= 1) {
    return name;
  }
  if (splited[0].includes("gpu_usage")) {
    return `gpu_${truncate(splited[1], { length: 3 })}(C.B by ${splited[-1]})`;
  }
  return `${splited[0]}(C.B ${splited[1]})`;
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
      let next_path = formPath(path, `${idx}`);
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
