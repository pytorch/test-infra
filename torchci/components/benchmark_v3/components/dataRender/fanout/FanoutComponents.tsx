import { FanoutComponentProps } from "components/benchmark_v3/configs/utils/fanoutRegistration";
import { useDashboardSelector } from "lib/benchmark/store/benchmark_dashboard_provider";
import BenchmarkChartSection from "../components/benchmarkTimeSeries/components/BenchmarkTimeSeriesChart/BenchmarkTimeSeriesChartSection";
import { BenchmarkComparisonGithubExternalLink } from "../components/benchmarkTimeSeries/components/BenchmarkTimeSeriesComparisonSection/BenchmarkTimeSeriesComparisonTable/GithubExternalLink";
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

export function FanoutBenchmarkComparisonGithubExternalLink({
  data = [],
  config,
  onChange,
  lcommit,
  rcommit,
}: FanoutComponentProps) {
  return (
    <BenchmarkComparisonGithubExternalLink
      lcommit={lcommit ?? undefined}
      rcommit={rcommit ?? undefined}
      title={{
        text: config?.title ?? "",
        description: config?.description ?? "",
      }}
    />
  );
}

export function FanoutBenchmarkTimeSeriesComparisonTableSection({
  data = [],
  config,
  onChange,
  lcommit,
  rcommit,
}: FanoutComponentProps) {
  const enableMultiBranchOption = useDashboardSelector(
    (s) => s.enableMultiBranchOption
  );

  return (
    <>
      <BenchmarkTimeSeriesComparisonTableSection
        tableSectionConfig={config}
        data={data}
        lcommit={lcommit ?? undefined}
        rcommit={rcommit ?? undefined}
        onChange={onChange}
        enableMultiBranchOption={enableMultiBranchOption}
      />
    </>
  );
}
