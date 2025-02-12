export const UTILIZATION_DEFAULT_REPO = "pytorch/pytorch";

export const UTIL_METADATA_QUERY_FOLDER_NAME = "oss_ci_util_metadata";

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

export interface UtilizationMetadataInfo {
  workflow_id: string;
  job_id: string;
  run_attempt: string;
  workflow_name: string;
  job_name: string;
  repo: string;
}

export interface ListUtilizationMetadataInfoParams {
  workflow_id: string;
  repo?: string;
}

export interface ListUtilizationMetadataInfoAPIResponse {
  metadata_list: UtilizationMetadataInfo[];
}
