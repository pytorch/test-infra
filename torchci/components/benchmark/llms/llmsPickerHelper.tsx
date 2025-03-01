interface LLMsPickerQueryParams {
  stringValueParams: StringItem[];
  arrayValueParams: ArrayItem[];
}

interface StringItem {
  label: string;
  value: string;
}

interface ArrayItem {
  label: string;
  value: string[];
}

// Default droplist initial values
export const DEFAULT_DEVICE_NAME = "All Devices";
export const DEFAULT_ARCH_NAME = "All Platforms";
export const DEFAULT_DTYPE_NAME = "All DType";
export const DEFAULT_MODE_NAME = "All Modes";
export const DEFAULT_BACKEND_NAME = "All Backends";
export const DEFAULT_MODEL_NAME = "All Models";
