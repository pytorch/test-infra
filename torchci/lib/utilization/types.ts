export interface UtilizationParams {
  workflow_id: string;
  job_id: string;
  run_attempt: string;
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
  ts_list: { name: string; value: TimeSeriesDataPoint[] }[];
}

export interface TimeSeriesDataPoint {
  ts: string;
  value: number;
}
