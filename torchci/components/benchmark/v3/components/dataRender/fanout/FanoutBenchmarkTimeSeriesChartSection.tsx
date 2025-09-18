import BenchmarkChartSection from "../components/benchmarkTimeSeries/components/BenchmarkChartSection";
import {
  BenchmarkChartSectionConfig,
  BenchmarkTimeSeriesInput,
} from "../components/benchmarkTimeSeries/helper";

export default function FanoutBenchmarkTimeSeriesChartSection({
  data = [],
  config,
  onChange,
}: {
  data?: BenchmarkTimeSeriesInput[];
  config: any;
  onChange?: (payload: any) => void;
}) {
  return (
    <div>
      <BenchmarkChartSection
        data={data}
        chartSectionConfig={config as BenchmarkChartSectionConfig}
        onChange={(payload) => {
          onChange?.(payload);
        }}
      />
    </div>
  );
}
