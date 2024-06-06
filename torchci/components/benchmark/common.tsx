export const SHA_DISPLAY_LENGTH = 10;
export const MAIN_BRANCH = "main";
export const LOG_PREFIX = "https://ossci-raw-job-status.s3.amazonaws.com/log";
export const DEFAULT_REPO_NAME = "pytorch/pytorch";
export const HUD_PREFIX = `/${DEFAULT_REPO_NAME}/commit`;
export const LAST_N_DAYS = 7;
export const TIME_FIELD_NAME = "granularity_bucket";
export const DASHBOARD_QUERY_MAP: { [k: string]: string } = {
  torchao: "torchao_query",
  torchinductor: "compilers_benchmarks_performance",
};
export const DASHBOARD_NAME_MAP: { [k: string]: string } = {
  torchao: "TorchAO",
  torchinductor: "TorchInductor",
};
