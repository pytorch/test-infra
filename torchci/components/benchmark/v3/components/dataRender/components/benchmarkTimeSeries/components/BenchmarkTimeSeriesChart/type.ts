export type RawTimeSeriesPoint = {
  granularity_bucket: string;
  value: number;
  commit: string;
  workflow_id?: string;
  branch?: string;
  name?: string;
  metric?: string;
  render_option?: {
    highlight?: boolean;
    color?: string;
  };
};

export type BenchmarkTimeSeriesInput = {
  legend_name?: string;
  group_info?: Record<string, string | number>;
  data: RawTimeSeriesPoint[];
};

export type BenchmarkTimeSeriesConfirmPayload = {
  seriesIndex: number;
  seriesName: string;
  groupInfo: Record<string, string | number>;
  left: RawTimeSeriesPoint;
  right: RawTimeSeriesPoint;
};

export const toEchartTimeSeriesData = (data: BenchmarkTimeSeriesInput) => {
  // sort by time asc and keep meta on each item
  return data.data
    .slice()
    .sort(
      (a, b) =>
        new Date(a.granularity_bucket).getTime() -
        new Date(b.granularity_bucket).getTime()
    )
    .map((p) => ({
      value: [new Date(p.granularity_bucket).getTime(), p.value] as [
        number,
        number
      ],
      legend_name: data.legend_name,
      meta: p,
    }));
};
