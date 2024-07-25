export const DEFAULT_REPO_NAME = "pytorch/ao";
export const DTYPES = ["amp", "bfloat16"];
export const DEFAULT_MODE = "inference";

export const DEFAULT_DEVICE_NAME = "cuda (a100)";
// TODO (huydhn): there is a way to avoid hard-coding dtypes and devices like how
// the LLM micro-benchmark page is implemented
export const DISPLAY_NAMES_TO_DEVICE_NAMES: { [k: string]: string } = {
  "cuda (a100)": "cuda",
};
