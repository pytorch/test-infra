export function extractBackendSqlStyle(
  output: string,
  suite: string,
  dtype: string,
  mode: string,
  device: string
): string | null {
  // This is only used in MPS, when the dtype is not set, it's actuall float32
  // but the output filename uses the notset string
  if (dtype === "float32" && device === "mps") {
    dtype = "notset";
  }

  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = `_${esc(suite)}_${esc(dtype)}_${esc(mode)}_${esc(device)}_`;

  const temp = output.replace(new RegExp(`${tail}.*$`), "");

  const m = temp.match(/.*[\/\\]([^\/\\]+)$/);
  return m ? m[1] : null;
}

export function toApiDeviceArch(
  device: string,
  arch: string
): [string, string] {
  const norm = arch.toLowerCase();
  // TODO (huydhn): Clean this up once the new name has been around for some time
  switch (device) {
    case "cpu":
      if (norm.includes("xeon") || norm.includes("x86_64"))
        return [device, "x86_64"];
      if (norm.includes("amd") || norm.includes("x86_zen"))
        return [device, "x86_zen"];
      return [device, norm];
    case "arm64-cpu":
      if (norm.includes("aarch64")) return ["cpu", norm];
      if (norm.includes("arm")) return ["mps", norm];
      return [device, norm];
    case "cuda":
      if (norm.includes("h100")) return [device, "h100"];
      if (norm.includes("a100")) return [device, "a100"];
      if (norm.includes("a10g")) return [device, "a10g"];
      if (norm.includes("b200")) return [device, "b200"];
      return [device, norm];
    case "rocm":
      if (norm.includes("mi300x")) return [device, "mi300x"];
      if (norm.includes("mi325x")) return [device, "mi325x"];
      if (norm.includes("radeon")) return [device, "mi355x"];
      return [device, norm];
    case "mps":
      return [device, norm];
    case "xpu":
      if (norm.includes("intel") || norm.includes("x86_64"))
        return [device, "x86_64"];
      return [device, norm];
    default:
      return [device, norm];
  }
}

function deepDiff(obj1: any, obj2: any) {
  const diffs: string[] = [];
  const allKeys = new Set([...Object.keys(obj1), ...Object.keys(obj2)]);
  for (const key of allKeys) {
    const v1 = obj1[key];
    const v2 = obj2[key];
    if (
      typeof v1 === "object" &&
      v1 !== null &&
      typeof v2 === "object" &&
      v2 !== null
    ) {
      if (JSON.stringify(v1) !== JSON.stringify(v2)) {
        diffs.push(
          `Key "${key}" differs: ${JSON.stringify(v1)} vs ${JSON.stringify(v2)}`
        );
      }
    } else if (v1 !== v2) {
      diffs.push(`Key "${key}" differs: ${v1} vs ${v2}`);
    }
  }

  return diffs;
}
