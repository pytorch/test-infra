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
      const newInfo = applyMapping(
        data,
        PYTORCH_OPERATOR_MICROBENCHMARK_MAPPING_FIELDS
      );
      const dn = toDeviceNameField(data.device, data.arch);
      return {
        ...data,
        ...newInfo,
        deviceName: dn,
      };
    default:
      return {
        deviceName: toDeviceNameField(data.device, data.arch),
        ...data,
      };
  }
}

export function toDeviceNameField(device: string, arch?: string) {
  if (!arch) {
    return device;
  }
  return `${device}||${arch}`;
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
  const newInfo: any = {};
  for (const [key, value] of Object.entries(info)) {
    if (mappingBook[key]) {
      // mapped field name
      const newKey = mappingBook[key];
      newInfo[newKey] = value;
    }
  }
  return newInfo;
}
