import { queryClickhouseSaved } from "lib/clickhouse";
import { TimeSeriesDataPoint, TimeSeriesDbData, UtilizationAPIResponse, UtilizationMetadata, UtilizationParams } from "./types";

const DEFAULT_REPO = "pytorch/pytorch";
const UTIL_TS_QUERY_FOLDER_NAME = "oss_ci_util_ts";
const UTIL_METADATA_QUERY_FOLDER_NAME = "oss_ci_util_metadata"

async function getUtilTimesSeries(
  workflow_id: number,
  job_id: number,
  run_attempt: number,
  type:string,
  from:string = "",
  to: string = "") {
    const response = await queryClickhouseSaved(UTIL_TS_QUERY_FOLDER_NAME, {
      workflowId: workflow_id,
      jobId: job_id,
      runAttempt: run_attempt,
      type: type,
      repo: DEFAULT_REPO,
    });
    return response;
  }

async function getUtilizationMetadata(
  workflow_id: number,
  job_id: number,
  run_attempt: number,
  type:string){
  const response = await queryClickhouseSaved(UTIL_METADATA_QUERY_FOLDER_NAME, {
    workflowId: workflow_id,
    jobId: job_id,
    runAttempt: run_attempt,
    type: type,
    repo: DEFAULT_REPO,
  });
  return response;
}

function getLatestMetadata(items: UtilizationMetadata[]): UtilizationMetadata | null {
  if (!items.length) return null;
  return items.reduce((latest, current) => {
    return new Date(latest.created_at) > new Date(current.created_at) ? latest : current;
  }, items[0]);
}

export default async function fetchUtilization(
  params: UtilizationParams
): Promise<UtilizationAPIResponse> {

  const meta_resp = await getUtilizationMetadata(params.workflow_id,
    params.job_id,
    params.run_attempt,
    params.type,
  )
  const metadata = getLatestMetadata(meta_resp)
  if (!metadata) {
    console.log("No util metadata found for workflow_id: " + params.workflow_id + " job_id: " + params.job_id + " run_attempt: " + params.run_attempt + " type: " + params.type);
    return {};
  }

  const resp: TimeSeriesDbData[] = await getUtilTimesSeries(
    params.workflow_id,
    params.job_id,
    params.run_attempt,
    params.type,
  );

  const tsList = flattenTS(resp)
  return {};
}

export function flattenTS(resp:TimeSeriesDbData[]){
  let tsData = new Map<String,TimeSeriesDataPoint[]>()
  resp.map((re) => {
    let data: any = JSON.parse(re.data);
    let dp:{name:string,value:number}[] = []
    getData(data,"",dp)
    dp.forEach((d)=>{
      const li = tsData.get(d.name) || [];
      li.push({
        ts: re.ts,
        value:d.value
      });
      if (!tsData.has(d.name)){
        tsData.set(d.name,li)
      }
    })
  })
  return tsData;
}

/**
 * Iterates throught nested object to form the name path, if found number it's value.
 * @param obj
 * @param path
 * @param res
 * @returns
 */
function getData(
  obj:any,
  path:string, res:{
  name: string,
  value: number,
}[]){
  if (!obj){
    return
  }

  if (checkType(obj) === "number"){
    res.push({name:path,value:obj})
    return
  }

  if (checkType(obj) == "array"){
    for (let idx = 0; idx < obj.length; idx++) {
      const nextObj = obj[idx]
      let next_path = path + "_" + idx
      if (checkType(nextObj) == "object"){
        if (nextObj.uuid){
          next_path = formPath(path,nextObj.uuid)
        }
      }
      getData(nextObj, next_path, res)
    }
  }
  if (checkType(obj)=== "object"){
    const keys = Object.keys(obj)
    for (let idx = 0; idx < keys.length; idx++) {
      const key = keys[idx]
      const el = obj[key]
      let nextP = formPath(path, key)
      getData(el, nextP, res)
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

function formPath(exist:string, addson: string){
  if(exist == ""){
    return addson
  }
  return `${exist}|${addson}`
}
