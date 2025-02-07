import {
  Segment,
  TimeSeriesDataPoint,
  TimeSeriesWrapper,
} from "lib/utilization/types";
import { sortBy } from "lodash";
import { DefaultCollectIntervalSeconds, StatsInfo, StatType } from "./types";

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

  if (res < 0) {
    return 0;
  }

  if (res >= dates.length) {
    return dates.length - 1;
  }

  return res;
}

export function getIgnoredSegmentName(): string[] {
  return ["tools.stats.monitor", "pip install", "filter_test_configs.py"];
}

export function processStatsData(ts: TimeSeriesWrapper[]): StatsInfo[] {
  let results: any[] = [];
  ts.forEach((ts) => {
    results = [
      ...results,
      { name: ts.name, id: ts.id, columns: getTimeSeriesStats(ts.records) },
    ];
  });
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

export function getTimeSeriesStats(dps: TimeSeriesDataPoint[]) {
  const records = dps.map((dp) => dp.value);
  // calculate average
  let results = [];
  if (records.length == 0) return [];
  const mean = records.reduce((acc, crt) => acc + crt, 0) / records.length;
  const mm = {
    type: "average",
    value: Number(mean.toFixed(2)),
    unit: "%",
  };
  results.push(mm);

  // calculate percentile 10th and 90th
  const p10Metric = getPercentile(records, 10);
  results.push(p10Metric);

  const p90Metric = getPercentile(records, 90);
  results.push(p90Metric);

  // calculate spikes, consider spike when utilization is greater or equal to 90 percent
  const spike90percent = countSpikes(records, 90);
  const spikeFrequency = (spike90percent / records.length) * 100;
  const spikeMetric = {
    type: StatType.SpikeFrequency,
    value: spikeFrequency,
    unit: "%",
  };
  results.push(spikeMetric);

  const avgSpikeInterval = findAvgSpikeIntervals(dps, p90Metric.value);
  const spikeAvgInterval = {
    type: StatType.SpikeAvgInterval,
    value: Number((avgSpikeInterval / 1000).toFixed(2)),
    unit: "%",
  };
  results.push(spikeAvgInterval);
  return results;
}

const findAvgSpikeIntervals = (
  timestamps: TimeSeriesDataPoint[],
  threshold: number
) => {
  const spikeIntervals = findSpikeIntervals(timestamps, threshold);
  if (spikeIntervals.length == 0) return -1; // No spikes
  const avgSpike =
    spikeIntervals.reduce((a, b) => a + b, 0) / spikeIntervals.length;
  return avgSpike;
};

const findSpikeIntervals = (
  timestamps: TimeSeriesDataPoint[],
  threshold: number
) => {
  if (timestamps.length == 0) return []; // No data

  let spikeTimes = timestamps.filter((ts: any) => ts.value >= threshold);
  let intervals = spikeTimes
    .slice(1)
    .map(
      (ts, i) =>
        new Date(ts.ts).getTime() - new Date(spikeTimes[i].ts).getTime()
    );
  return intervals;
};

const countSpikes = (data: any, threshold: number) => {
  return data.filter((value: number) => value >= threshold).length;
};

function sortByValue(data: number[]) {
  if (data.length == 0) return -1; // No data
  const sortedValues = sortBy(data);
  return sortedValues;
}

function calculatePercentile(data: any, threshold: number) {
  let index = Math.floor(data.length * (threshold / 100));
  if (index < 0) {
    index = 0;
  }
  if (index >= data.length) {
    index = data.length - 1;
  }
  return data[index];
}

function getPercentile(records: number[], p: number) {
  let data = sortByValue(records);
  const pValue = calculatePercentile(data, p);
  return {
    type: `p${p}`,
    value: Number(pValue.toFixed(2)),
    unit: "%",
  };
}

export function toDate(timestamp: string): Date {
  return new Date(timestamp);
}

export function getDurationMetrics(
  start: Date,
  end: Date,
  name: string,
  id?: string
) {
  const duration = (end.getTime() - start.getTime()) / 1000 / 60;
  let metricId = id || name;
  const item = {
    name: name,
    id: metricId,
    value: Number(duration.toFixed(2)),
    metric: "total",
    unit: "mins",
  };
  return { name: name, metrics: item };
}

export function getSegmentStatsAndTimeSeries(
  segment: Segment,
  timeSeriesList: TimeSeriesWrapper[]
): { stats: StatsInfo[]; timeSeries: any[] } | null {
  const startDate = toDate(segment.start_at);
  const endDate = toDate(segment.end_at);
  if (!startDate || !endDate) {
    console.log("Invalid start or end date for single test view", segment.name);
    return null;
  }
  // slice each time series for test segment
  const testTsList: TimeSeriesWrapper[] = [];
  for (const ts of timeSeriesList) {
    const records = ts.records;
    const s_index = findClosestDate(
      startDate,
      records.map((el: TimeSeriesDataPoint) => toDate(el.ts))
    );
    const e_index = findClosestDate(
      endDate,
      records.map((el: TimeSeriesDataPoint) => toDate(el.ts))
    );
    const testTs = records.slice(s_index, e_index + 1);
    testTsList.push({
      name: ts.name,
      id: ts.id,
      records: testTs,
    });
  }
  const stats: StatsInfo[] = processStatsData(testTsList);
  return { stats, timeSeries: testTsList };
}

export function getDuration(segment: Segment) {
  let res =
    (toDate(segment.end_at).getTime() - toDate(segment.start_at).getTime()) /
    1000;
  if (res == 0) {
    return DefaultCollectIntervalSeconds;
  }
  return res;
}

export function formatSeconds(seconds: number) {
  if (seconds < 60) {
    return seconds + "s";
  }

  if (seconds < 60 * 60) {
    return (seconds / 60).toFixed(2) + "m";
  }

  return (seconds / 3600).toFixed(2) + "h";
}
