import {
  PYTORCH_OPERATOR_MICROBENCHMARK_ID,
  PYTORCH_OPERATOR_MICROBENCHMARK_MAPPING_FIELDS,
} from "../teams/torchao/config";

export function getBenchmarkFields(data: any, id: string) {
  switch (id) {
    case "compiler_inductor":
      const deviceName = toCompilerBenchmarkDisplayName(data.device, data.arch);
      return {
        ...data,
        deviceName,
      };
    case PYTORCH_OPERATOR_MICROBENCHMARK_ID:
      applyMapping(data, PYTORCH_OPERATOR_MICROBENCHMARK_MAPPING_FIELDS);
      return {
        ...data,
      };
    default:
      return {
        deviceName: toDeviceName(data.device, data.arch),
        ...data,
      };
  }
}
export function toDeviceName(device: string, arch?: string) {
  if (!arch) {
    return device;
  }
  return `${device} (${arch})`;
}

export function toCompilerBenchmarkDisplayName(device: string, arch: string) {
  if (device === "rocm") {
    return "rocm (mi300x)";
  }
  if (device === "mps") {
    return "mps";
  }
  return `${device} (${arch})`;
}

function applyMapping(
  info: Record<string, any>,
  mappingBook: Record<string, string>
) {
  for (const [key, value] of Object.entries(info)) {
    if (mappingBook[key]) {
      // mapped field name
      const newKey = mappingBook[key];
      info[newKey] = value;
    }
  }
}
