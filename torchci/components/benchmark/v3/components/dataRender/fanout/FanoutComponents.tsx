import BenchmarkChartSection from "../components/benchmarkTimeSeries/BenchmarkChartSection";
import BenchmarkTimeSeriesComparisonTableSection from "../components/benchmarkTimeSeries/components/BenchmarkTimeSeriesComparisonSection/BenchmarkTimeSeriesComparisonTableSection";
import {
  BenchmarkChartSectionConfig,
  BenchmarkTimeSeriesInput,
} from "../components/benchmarkTimeSeries/helper";

export function FanoutBenchmarkTimeSeriesChartSection({
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

export function FanoutBenchmarkTimeSeriesComparisonTableSection({
  data = [],
  config,
  onChange,
}: {
  data?: any[];
  config: any;
  onChange?: (payload: any) => void;
}) {
  return (
    <>
      <BenchmarkTimeSeriesComparisonTableSection
        tableSectionConfig={config}
        data={data}
      />
    </>
  );
}
