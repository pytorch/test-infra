import {
  Segment,
  TimeSeriesDataPoint,
  TimeSeriesWrapper,
} from "lib/utilization/types";
import { sortBy } from "lodash";
import { AgggregateMethod, StatsInfo, StatsItem, StatType } from "./types";

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

export function processStatsData(
  resourceTimeSeries: TimeSeriesWrapper[]
): StatsInfo[] {
  let results: any[] = [];
  resourceTimeSeries.forEach((ts) => {
    results = [
      ...results,
      { name: ts.name, id: ts.id, columns: getTimeSeriesStats(ts.records) },
    ];
  });

  const allGpus = getAllGpusStats(results);
  results = [...results, ...allGpus];
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

  const p50Metric = getPercentile(records, 50);
  results.push(p50Metric);

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

  const max = findMaxValue(records);
  const maxStat = {
    type: StatType.Max,
    value: max,
    unit: "%",
  };
  results.push(maxStat);
  return results;
}

export const findMaxValue = (data: number[]) => {
  if (data.length == 0) return 0; // No data
  const max = data.reduce((a, b) => Math.max(a, b), 0);
  return max;
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
  return res;
}

export function formatSeconds(seconds: number) {
  // this normally means the test is detected during the aggregation proccess for a test interval, so we show <5s
  if (seconds == 0) {
    return "< 5s";
  }
  if (seconds < 60) {
    return seconds + "s";
  }

  if (seconds < 60 * 60) {
    return (seconds / 60).toFixed(2) + "mins";
  }

  return (seconds / 3600).toFixed(2) + "hs";
}

export function toNumberList(data: StatsInfo[], statType: StatType) {
  return data.map((item) => {
    const val = item.columns.find((col) => col.type === statType);
    if (val == undefined) {
      return 0;
    }
    return val.value;
  });
}
export function calculateAverage(data: number[]) {
  if (data.length == 0) return 0; // No data
  const sum = data.reduce((a, b) => a + b, 0);
  return sum / data.length;
}

function getAllGpusStats(stats: StatsInfo[]) {
  // get all gpus stats for the test
  const gpuUtils = stats.filter((item) => item.id.includes("|util_percent"));
  const gpuMems = stats.filter((item) => item.id.includes("|mem_util_percent"));

  if (gpuUtils.length == 0) {
    return [];
  }

  // calculate stats for all gpus
  const allGpus: StatsInfo[] = [
    {
      name: "gpus_util_all",
      id: "gpus_util_all",
      columns: [
        aggregateStats(gpuUtils, StatType.Average, AgggregateMethod.Average),
        aggregateStats(gpuUtils, StatType.Max, AgggregateMethod.Max),
        aggregateStats(
          gpuUtils,
          StatType.SpikeFrequency,
          AgggregateMethod.Average
        ),
        aggregateStats(
          gpuUtils,
          StatType.SpikeAvgInterval,
          AgggregateMethod.Average
        ),
      ],
    },
    {
      name: "gpu_mem_all",
      id: "gpu_mem_all",
      columns: [
        aggregateStats(gpuMems, StatType.Average, AgggregateMethod.Average),
        aggregateStats(gpuMems, StatType.Max, AgggregateMethod.Max),
        aggregateStats(
          gpuMems,
          StatType.SpikeFrequency,
          AgggregateMethod.Average
        ),
        aggregateStats(
          gpuMems,
          StatType.SpikeAvgInterval,
          AgggregateMethod.Max
        ),
      ],
    },
  ];
  return allGpus;
}

function aggregateStats(
  stats: StatsInfo[],
  statType: StatType,
  method: AgggregateMethod
): StatsItem {
  let value = 0;
  switch (method) {
    case AgggregateMethod.Average:
      value = calculateAverage(toNumberList(stats, statType));
      break;
    case AgggregateMethod.Max:
      value = findMaxValue(toNumberList(stats, statType));
      break;
    default:
      value = 0;
  }
  return {
    type: statType,
    value: Number(value.toFixed(2)),
    unit: "%",
  };
}
