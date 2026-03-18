import { Divider, Paper, Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";
import { StaticRenderViewOnlyContent } from "components/benchmark_v3/components/common/StaticRenderViewOnlyContent";
import {
  BenchmarkTimeSeriesInput,
  RawTimeSeriesPoint,
} from "components/benchmark_v3/components/dataRender/components/benchmarkTimeSeries/helper";
import BenchmarkTimeLineSelectSeriesChart from "../../dataRender/components/benchmarkTimeSeries/components/BenchmarkTimeSeriesChart/BenchmarkTimeLineSelectSeriesChart";
import {
  DEFAULT_BASELINE_COLOR,
  DEFAULT_REGRESSION_COLOR,
  GroupInfoChips,
  RegressionReportChartIndicatorsSection,
  ReportPageToV3MainPageNavigationButton,
} from "../common";

type SingleReportSectionConfig = {
  hidePolicy?: boolean;
  hideBaseline?: boolean;
  hideChips?: boolean;
  subtitle?: string;
  enableIndicator?: boolean;
  enableNavigation?: boolean;
  report_id: string;
  id?: string;
};

type SingleReportSectionProps = {
  data: any;
  config?: SingleReportSectionConfig;
};

const DEFAULT_CONFIG: Required<
  Pick<
    SingleReportSectionConfig,
    | "hidePolicy"
    | "hideBaseline"
    | "hideChips"
    | "subtitle"
    | "enableIndicator"
    | "enableNavigation"
  >
> = {
  hidePolicy: false,
  hideBaseline: false,
  hideChips: false,
  subtitle: "",
  enableIndicator: false,
  enableNavigation: true,
};

export function SingleReportSection({
  data,
  config,
}: SingleReportSectionProps) {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  if (!data) {
    return <div />;
  }

  const group_info = data?.group_info ?? {};
  const tsData = [toTimeSeriesData(data, ["metric"])];
  const baseline = data?.baseline_point;
  const latestPoint = data?.points[data?.points?.length - 1];

  return (
    <Stack spacing={1.25}>
      {cfg?.subtitle && (
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          {cfg?.subtitle}
        </Typography>
      )}
      {!cfg.hideChips && (
        <GroupInfoChips info={group_info} chipSx={{ fontSize: 10 }} />
      )}
      <Box sx={{ mt: 0.5 }}>
        <BenchmarkTimeLineSelectSeriesChart
          timeseries={tsData}
          enableSelectLine={false}
        />
      </Box>
      <Divider />
      {cfg?.enableIndicator && (
        <>
          <RegressionReportChartIndicatorsSection />
          <Divider />
        </>
      )}

      {!cfg?.hidePolicy && (
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            Policy: how we detect the regression based on baseline point
          </Typography>
          <StaticRenderViewOnlyContent
            data={data.policy}
            title=""
            maxDepth={10}
          />
        </Box>
      )}
      {!cfg?.hideBaseline && (
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            Baseline Point: the point we use as baseline to detect the
            regression
          </Typography>
          <StaticRenderViewOnlyContent data={baseline} title="" maxDepth={10} />
        </Box>
      )}
      {cfg?.enableNavigation && cfg?.report_id && (
        <Stack direction="row" alignItems="center">
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            Go to the benchmark main page
          </Typography>
          <ReportPageToV3MainPageNavigationButton
            report_id={cfg?.report_id}
            group_info={group_info}
            startCommit={baseline}
            endCommit={latestPoint}
          />
        </Stack>
      )}
    </Stack>
  );
}

export function ReportTimeSeriesChartSection({
  data,
  subtitle = "",
  id,
  report_id,
  hidePolicy = false,
  hideBaseline = false,
  hideChips = false,
  enableIndicator = false,
  enableNavigation = true,
}: {
  data: any;
  subtitle: string;
  report_id: string;
  id?: string;
  hidePolicy?: boolean;
  hideBaseline?: boolean;
  hideChips?: boolean;
  enableIndicator?: boolean;
  enableNavigation?: boolean;
}) {
  return (
    <Paper id={id} variant="outlined" sx={{ p: 2 }}>
      <SingleReportSection
        data={data}
        config={{
          report_id,
          id,
          hidePolicy,
          hideBaseline,
          hideChips,
          subtitle,
          enableIndicator,
          enableNavigation,
        }}
      />
    </Paper>
  );
}

/**
 * Single Report Wrapper for the customized dialog in group chart view
 * @param param0
 * @returns
 */
export function SingleReportSectionDialog({
  data,
  config,
}: SingleReportSectionProps) {
  const d = data?.raw_data;
  return <SingleReportSection data={d} config={config} />;
}

export function ReportTimeSeriesGroupChartSection({
  data,
  subtitle = "",
  id,
  report_id,
  enableSelectLine = false,
}: {
  data: any[];
  subtitle: string;
  report_id: string;
  id?: string;
  enableSelectLine?: boolean;
  enableNavigation?: boolean;
}) {
  const tsData = data.map((item) =>
    toTimeSeriesData(item, [], ["device", "arch", "metric", "branch"])
  );
  const dialogConfig = {
    report_id: report_id,
  };
  return (
    <Paper id={id} variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        {subtitle}
      </Typography>
      <Stack spacing={1.25}>
        <Box sx={{ mt: 0.5 }}>
          <BenchmarkTimeLineSelectSeriesChart
            timeseries={tsData}
            enableSelectLine={enableSelectLine}
            renderOptions={{ height: 300 }}
            customizedDialog={{
              config: dialogConfig,
              comp: SingleReportSectionDialog,
            }}
          />
        </Box>
      </Stack>
    </Paper>
  );
}

// Converts the regression report data to a format that can be used by the benchmark time series chart
function toTimeSeriesData(
  data: any,
  legend_name_fields: string[] = [],
  execludes_legend_names: string[] = []
): BenchmarkTimeSeriesInput {
  let res: BenchmarkTimeSeriesInput[] = [];
  const group_info = data?.group_info ?? {};
  const baseline = data?.baseline_point;
  const allBaslinepoints = data?.all_baseline_points;

  const points = data?.points;
  const all = [...allBaslinepoints, ...points].map((item) => {
    let res = toRawTimeSeriesPoint(item, group_info);
    if (item?.workflow_id === baseline?.workflow_id) {
      res = {
        ...res,
        renderOptions: {
          size: 15,
          color: DEFAULT_BASELINE_COLOR,
        },
      };
    }
    if (item?.flag === true) {
      res = {
        ...res,
        renderOptions: {
          size: 10,
          color: DEFAULT_REGRESSION_COLOR,
        },
      };
    }
    return res;
  });

  let groups = Object.entries(group_info);
  if (legend_name_fields.length > 0) {
    groups = groups.filter(([key, value]) => legend_name_fields.includes(key));
  }

  if (execludes_legend_names.length > 0) {
    groups = groups.filter(
      ([key, value]) => !execludes_legend_names.includes(key)
    );
  }

  return {
    group_info,
    legend_name: groups.map(([key, value]) => `${key}: ${value}`).join(" "),
    data: all,
    raw_data: data,
  } as BenchmarkTimeSeriesInput;
}

function toRawTimeSeriesPoint(data: any, group_info: any): RawTimeSeriesPoint {
  const ts = data?.timestamp;
  return {
    ...data,
    group_info,
    metric: group_info?.metric ?? "unknown",
    granularity_bucket: ts,
  };
}
