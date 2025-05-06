export const UTILIZATION_DEFAULT_REPO = "pytorch/pytorch";

export const EMPTY_LIST_UTILIZATION_METADATA_INFO_API_RESPONSE: ListUtilizationMetadataInfoAPIResponse =
  {
    workflow_id: "",
    workflow_name: "",
    metadata_list: [],
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
  gpu_memory_max?: number;
  gpu_memory_avg?: number;
  gpu_p90?: number;
  gpu_memmory_p90?: number;
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
