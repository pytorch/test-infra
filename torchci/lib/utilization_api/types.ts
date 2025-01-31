
export interface UtilizationParams {
    workflow_id:number;
    job_id:number;
    run_attempt:number;
    type:string;
    repo:string;
}

export interface TimeSeriesDbData {
    ts: string;
    data: string;
    tags: string[]
}

export interface UtilizationMetadata{
    collect_interval: number,
    model_version: string,
    gpu_count: number,
    gpu_type: string,
    cpu_count: number,
    start_at: string,
    end_at: string,
    created_at: string,
    workflow_name: string,
    job_name: string,
    segments: any[]
}

export interface Segments{
    level: string,
    name: string,
    start_at: string,
    end_at: string,
    extra_info: any,
}

export interface UtilizationAPIResponse{

}

export interface TimeSeriesDataPoint{
    ts: string,
    value: number,
}
