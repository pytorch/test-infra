export function getBenchmarkFields(data: any, id: string) {
  switch (id) {
    case "compiler_inductor":
      const deviceName = toCompilerBenchmarkDisplayName(data.device, data.arch);
      return {
        ...data,
        deviceName,
      };
    default:
      return data;
  }
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
