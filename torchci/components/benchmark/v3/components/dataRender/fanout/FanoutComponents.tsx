import { FanoutComponentProps } from "components/benchmark/v3/configs/utils/fanoutRegistration";
import BenchmarkChartSection from "../components/benchmarkTimeSeries/BenchmarkChartSection";
import BenchmarkTimeSeriesComparisonTableSection from "../components/benchmarkTimeSeries/components/BenchmarkTimeSeriesComparisonSection/BenchmarkTimeSeriesComparisonTableSection";
import { BenchmarkChartSectionConfig } from "../components/benchmarkTimeSeries/helper";

export function FanoutBenchmarkTimeSeriesChartSection({
  data = [],
  config,
  onChange,
  lcommit,
  rcommit,
}: FanoutComponentProps) {
  return (
    <div>
      <BenchmarkChartSection
        data={data}
        chartSectionConfig={config as BenchmarkChartSectionConfig}
        onSelect={(payload) => {
          onChange?.(payload);
        }}
        lcommit={lcommit ?? undefined}
        rcommit={rcommit ?? undefined}
      />
    </div>
  );
}

export function FanoutBenchmarkTimeSeriesComparisonTableSection({
  data = [],
  config,
  onChange,
  lcommit,
  rcommit,
}: FanoutComponentProps) {
  return (
    <>
      <BenchmarkTimeSeriesComparisonTableSection
        tableSectionConfig={config}
        data={data}
        lcommit={lcommit ?? undefined}
        rcommit={rcommit ?? undefined}
        onChange={onChange}
      />
    </>
  );
}
