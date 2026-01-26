export interface BenchmarkDataFetcher {
  applyFormat(
    data: any[],
    formats: string[],
    includesAllExtraKey?: boolean
  ): any;
  applyQuery(inputs: string): Promise<any>;
}

export interface BenchmarkMetadataFetcher {
  postProcess(data: any[]): any;
  applyQuery(inputs: string): Promise<any>;
}

export interface BenchmarkListCommitFetcher {
  postProcess(data: any[]): any;
  applyQuery(inputs: string): Promise<any>;
}
