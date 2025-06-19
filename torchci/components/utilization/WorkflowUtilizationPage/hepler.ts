export function computeAverages(jobs: any[]) {
  let memorySum = 0,
    memoryCount = 0;
  let cpuSum = 0,
    cpuCount = 0;
  let gpuSum = 0,
    gpuCount = 0;
  let gpuMemSum = 0,
    gpuMemCount = 0;

  for (const job of jobs) {
    const stats = job.stats;
    if (!stats) continue;
    if (stats.memory_avg && typeof stats.memory_avg === "number") {
      memorySum += stats.memory_avg;
      memoryCount += 1;
    }

    if (stats.cpu_avg && typeof stats.cpu_avg === "number") {
      cpuSum += stats.cpu_avg;
      cpuCount += 1;
    }

    if (stats.gpu_avg && typeof stats.gpu_avg === "number") {
      gpuSum += stats.gpu_avg;
      gpuCount += 1;
    }

    if (stats.gpu_memory_avg && typeof stats.gpu_memory_avg === "number") {
      gpuMemSum += stats.gpu_memory_avg;
      gpuMemCount += 1;
    }
  }

  return [
    {
      value: memoryCount > 0 ? (memorySum / memoryCount).toFixed(2) : null,
      name: "memory usage avg",
      unit: "%",
    },
    {
      value: cpuCount > 0 ? (cpuSum / cpuCount).toFixed(2) : null,
      name: "cpu usage avg",
      unit: "%",
    },
    {
      value: gpuCount > 0 ? (gpuSum / gpuCount).toFixed(2) : null,
      name: "gpu usage avg",
      unit: "%",
    },
    {
      value: gpuMemCount > 0 ? (gpuMemSum / gpuMemCount).toFixed(2) : null,
      name: "gpu mem avg",
      unit: "%",
    },
  ];
}
