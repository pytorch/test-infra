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

/**
 * StatsInfo is a struct that contains information about a stat.
 *
 * It contains the following fields:
 * @name the name of hardware reource
 * @id the id of hardware resource
 * @columns the stats of the hardware resource.
 * e.g data:
 *  {
 *   name: "cpu",
 *   id: "cpu",
 *   columns: [
 *     {
 *       type: "average",
 *      value: 0.5,
 *      unit: "%",
 *      },
 *    {
 *      type: "max",
 *      value: 0.8,
 *      unit: "%",
 *     }],
 * }
 */
export interface StatsInfo {
  name: string;
  id: string;
  columns: StatsItem[];
}

export enum AgggregateMethod {
  Average = "average",
  Max = "max",
}
