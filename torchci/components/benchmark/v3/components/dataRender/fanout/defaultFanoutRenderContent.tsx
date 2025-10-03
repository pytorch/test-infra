import { Divider, Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";
import { HighlightStyles } from "components/benchmark/v3/components/common/highlight";
import { getConfig } from "components/benchmark/v3/configs/configBook";
import { getFanoutRenderComponent } from "components/benchmark/v3/configs/utils/fanoutRegistration";
import LoadingPage from "components/common/LoadingPage";
import { useBenchmarkData } from "lib/benchmark/api_helper/apis/hooks";
import { useDashboardSelector } from "lib/benchmark/store/benchmark_dashboard_provider";
import { BenchmarkCommitMeta } from "lib/benchmark/store/benchmark_regression_store";
import { useState } from "react";
import { ToggleSection, toToggleSectionId } from "../../common/ToggleSection";

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
    committedLbranch,
    committedRbranch,
    lcommit,
    rcommit,
    setLcommit,
    setRcommit,
  } = useDashboardSelector((s) => ({
    benchmarkId: s.benchmarkId,
    committedTime: s.committedTime,
    committedFilters: s.committedFilters,
    committedLbranch: s.committedLbranch,
    committedRbranch: s.committedRbranch,
    lcommit: s.lcommit,
    rcommit: s.rcommit,
    setLcommit: s.setLcommit,
    setRcommit: s.setRcommit,
  }));
  const [payload, setPayload] = useState(null);
  const config = getConfig(benchmarkId);
  const requiredFilters = config.dataBinding.raw.required_filter_fields;
  const dataRender = config.raw.dataRender;

  const branches = [
    ...new Set(
      [committedLbranch, committedRbranch].filter((b) => b.length > 0)
    ),
  ];

  const ready =
    !!committedTime?.start &&
    !!committedTime?.end &&
    !!committedLbranch &&
    !!committedRbranch &&
    requiredFilters.every((k: string) => !!committedFilters[k]);

  const onChange = (payload: any) => {
    setPayload(payload);
    const { left, right } = payload;
    const lcommit = left?.commit;
    const rcommit = right?.commit;
    if (lcommit) {
      const commitInfo: BenchmarkCommitMeta = {
        commit: lcommit,
        branch: left.branch,
        date: left.granularity_bucket,
        workflow_id: left.workflow_id,
      };
      setLcommit(commitInfo);
    }
    if (rcommit) {
      const commitInfo: BenchmarkCommitMeta = {
        commit: rcommit,
        branch: right.branch,
        date: right.granularity_bucket,
        workflow_id: right.workflow_id,
      };
      setRcommit(commitInfo);
    }
  };

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
    <>
      <HighlightStyles />
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
              <div key={index} id={toToggleSectionId(index + 1)}>
                unable to fetch fanout component {fanoutUIConfig.type}
              </div>
            );
          }
          const title = fanoutUIConfig.title ?? `Section ${index + 1}`;
          return (
            <ToggleSection
              key={index}
              title={title}
              id={toToggleSectionId(index + 1)}
            >
              <Component
                data={multidata[data_path]}
                config={fanoutUIConfig.config}
                onChange={onChange}
                lcommit={lcommit}
                rcommit={rcommit}
              />
            </ToggleSection>
          );
        })}
      </Box>
    </>
  );
}
