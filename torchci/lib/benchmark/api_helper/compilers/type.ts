export enum CompilerQueryType {
  PRECOMPUTE = "precompute",
  GENERAL = "general",
}

export function getExtremeTs(
  rawData: Array<{ granularity_bucket: string | number | Date }>,
  mode: "min" | "max"
): number | null {
  if (!rawData?.length) return null;

  let extreme = mode === "min" ? Infinity : -Infinity;

  for (const row of rawData) {
    const ts = new Date(row.granularity_bucket as any).getTime();
    if (!Number.isFinite(ts)) continue;

    if (mode === "min") {
      if (ts < extreme) extreme = ts;
    } else {
      if (ts > extreme) extreme = ts;
    }
  }

  return Number.isFinite(extreme) ? extreme : null;
}
