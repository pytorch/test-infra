export const UTILIZATION_DEFAULT_REPO = "pytorch/pytorch";

export const EMPTY_LIST_UTILIZATION_METADATA_INFO_API_RESPONSE: ListUtilizationMetadataInfoAPIResponse =
  {
    workflow_id: "",
    workflow_name: "",
    metadata_list: [],
  };


  export const EMPTY_LIST_WORKFLOWS_UTILIZATION_METADATA_INFO_API_RESPONSE: ListWorkflowsUtilizationMetadataInfoAPIResponse =
  {
     metadata_map: {},
  };
export interface UtilizationParams {
  workflow_id: string;
  job_id: string;
  run_attempt: string;
  repo?: string;
}

export interface TimeSeriesDbData {
  ts?: string | null;
  data?: string | null;
  tags?: string[] | null;
}

export interface UtilizationMetadata {
  collect_interval: number;
  model_version: string;
  gpu_count: number;
  gpu_type: string;
  cpu_count: number;
  start_at: string;
  end_at: string;
  created_at: string;
  workflow_name: string;
  job_name: string;
  segments: Segment[];
}

export interface Segment {
  level: string;
  name: string;
  start_at: string;
  end_at: string;
  extra_info: any;
}

export interface UtilizationAPIResponse {
  metadata: UtilizationMetadata;
  ts_list: TimeSeriesWrapper[];
  raw: any;
}

export interface TimeSeriesWrapper {
  id: string;
  name: string;
  records: TimeSeriesDataPoint[];
}

export interface TimeSeriesDataPoint {
  ts: string;
  value: number;
}

export interface ListUtilizationMetadataInfoParams {
  workflow_id: string;
  repo?: string;
  include_stats?: boolean;
}

export interface UtilizationMetadataInfo {
  workflow_id: string;
  job_id: string;
  run_attempt: string;
  workflow_name: string;
  job_name: string;
  repo: string;
  stats?: UtilizationAggreStats;
}

export interface UtilizationAggreStats {
  has_gpu: boolean;
  cpu_max: number;
  cpu_avg: number;
  cpu_p90: number;
  memory_max: number;
  memory_avg: number;
  memory_p90: number;
  gpu_max?: number;
  gpu_avg?: number;
  gpu_p90?: number;
  gpu_memory_bandwidth_max?: number;
  gpu_memory_bandwidth_avg?: number;
  gpu_memory_bandwidth_p90?: number;
  gpu_allocated_memory_max?: number;
  gpu_allocated_memory_avg?: number;
  gpu_allocated_memory_p90?: number;
}


export interface ListWorkflowsUtilizationMetadataInfoAPIResponse {
  metadata_map:{
    [key: number]: UtilizationMetadataInfo[];
  }
}

/**
 * The response of the API call to list utilization metadata info.
 * @param metadata_list The list of utilization metadata info.
 *
 */
export interface ListUtilizationMetadataInfoAPIResponse {
  workflow_id?: string;
  workflow_name?: string;
  metadata_list: UtilizationMetadataInfo[];
}

export interface ListUtilizationReportAPIResponse {
  group_key?: string;
  metadata_list?: any[];
  min_time?: any;
  max_time?: any;
  error?: string;
}

export interface ListUtilizationReportParams {
  repo?: string;
  group_by?: string;
  granularity?: string;
  start_time?: string;
  end_time?: string;
  parent_group?: string;
}

export const EMPTY_LIST_UTILIZATION_SUMMARY_API_RESPONSE: ListUtilizationReportAPIResponse =
  {
    group_key: "",
    metadata_list: [],
  };
