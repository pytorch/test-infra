export function getIgnoredSegmentName(): string[] {
  return ["tools.stats.monitor", "pip install", "filter_test_configs.py"];
}

export function findClosestDate(targetDate: Date, dates: Date[]): number {
  if (dates.length === 0) {
    return -1;
  }
  let low = 0;
  let high = dates.length - 1;
  let res = 0;
  let minDiff = Infinity;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const currentDate = dates[mid];
    const currentDiff = Math.abs(targetDate.getTime() - currentDate.getTime());

    if (currentDiff < minDiff) {
      minDiff = currentDiff;
      res = mid;
    }

    if (currentDate < targetDate) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return res;
}
