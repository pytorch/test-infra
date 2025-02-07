export enum StatType {
  Average = "average",
  Max = "max",
  P50 = "p50",
  P10 = "p10",
  P90 = "p90",
  SpikeFrequency = "spike_frequency",
  SpikeAvgInterval = "spike_avg_interval",
}

export interface StatsItem {
  type: string;
  value: number;
  unit: string;
}

export interface StatsInfo {
  name: string;
  id: string;
  columns: StatsItem[];
}
