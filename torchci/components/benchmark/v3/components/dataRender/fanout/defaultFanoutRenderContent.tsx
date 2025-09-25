import { Divider, Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";
import { getConfig } from "components/benchmark/v3/configs/configBook";
import { getFanoutRenderComponent } from "components/benchmark/v3/configs/utils/fanoutRegistration";
import LoadingPage from "components/common/LoadingPage";
import { useBenchmarkData } from "lib/benchmark/api_helper/compilers/type";
import { useDashboardSelector } from "lib/benchmark/store/benchmark_dashboard_provider";
import { useState } from "react";
import { ToggleSection } from "../../common/ToggleSection";

/**
 * The default fanout component fetches pre-processed data for chart,
 * table and other components in one api
 * @returns
 */
export function DefaultFanoutRenderContent() {
  const {
    benchmarkId,
    committedTime,
    committedFilters,
    committedLbranch: committedLBranch,
    committedRbranch: committedRBranch,
  } = useDashboardSelector((s) => ({
    benchmarkId: s.benchmarkId,
    committedTime: s.committedTime,
    committedFilters: s.committedFilters,
    committedLbranch: s.committedLbranch,
    committedRbranch: s.committedRbranch,
  }));
  const [payload, setPayload] = useState(null);
  const config = getConfig(benchmarkId);
  const requiredFilters = config.dataBinding.raw.required_filter_fields;
  const dataRender = config.raw.dataRender;

  const branches = [
    ...new Set(
      [committedLBranch, committedRBranch].filter((b) => b.length > 0)
    ),
  ];

  const ready =
    !!committedTime?.start &&
    !!committedTime?.end &&
    !!committedLBranch &&
    !!committedRBranch &&
    requiredFilters.every((k: string) => !!committedFilters[k]);

  // convert to the query params
  const params = config.dataBinding.toQueryParams({
    timeRange: committedTime,
    branches,
    filters: committedFilters,
  });
  const queryParams: any | null = ready ? params : null;

  // fetch the bechmark data
  const {
    data: resp,
    isLoading,
    error,
  } = useBenchmarkData(benchmarkId, queryParams);
  if (isLoading) {
    return <LoadingPage />;
  }
  if (error) {
    return <div>Error: {error.message}</div>;
  }

  if (!dataRender?.renders) {
    return <div>no data render</div>;
  }

  if (!resp?.data?.data) {
    return <div>no data</div>;
  }

  const fanoutUIConfigs = dataRender.renders;
  const multidata = resp.data.data;

  return (
    <Box>
      <Stack spacing={1}>
        <Typography variant="h2"> {config.raw.title} </Typography>
      </Stack>
      <Divider />
      {fanoutUIConfigs.map((fanoutUIConfig, index) => {
        const { Component, data_path } =
          getFanoutRenderComponent(fanoutUIConfig);
        if (!data_path) {
          return (
            <div key={index}>
              unable to fetch fanout component {fanoutUIConfig.type}
            </div>
          );
        }
        const title = fanoutUIConfig.title ?? `Section ${index + 1}`;
        return (
          <ToggleSection key={index} title={title}>
            <Component
              data={multidata[data_path]}
              config={fanoutUIConfig.config}
              onChange={setPayload}
            />
          </ToggleSection>
        );
      })}
    </Box>
  );
}
