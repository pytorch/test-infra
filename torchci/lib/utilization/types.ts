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
  ts_list: TimeSeriesObject[];
  hardware_metrics: Metrics[];
}

export interface TimeSeriesObject {
  name: string;
  displayname: string;
  records: TimeSeriesDataPoint[];
}

export interface TimeSeriesDataPoint {
  ts: string;
  value: number;
}

export interface Metrics {
  displayname: string;
  name: string;
  value: number;
  metric: string;
  unit: string;
  description?: string;
}

export enum MetricType {
  AVERAGE = 'average',
  PERCENTILE_90TH = 'percentile_90th',
  PERCENTILE_50TH = 'percentile_50th',
}
