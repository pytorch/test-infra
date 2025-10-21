import { Divider, Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";
import { HighlightStyles } from "components/benchmark_v3/components/common/highlight";
import { getAutoRenderComponent } from "components/benchmark_v3/configs/utils/autoRegistration";
import LoadingPage from "components/common/LoadingPage";
import { useBenchmarkCommittedContext } from "lib/benchmark/api_helper/fe/hooks";
import { useDashboardSelector } from "lib/benchmark/store/benchmark_dashboard_provider";
import { BackToMainButton } from "../../common/BackToMainButton";

/**
 * The default fanout component fetches pre-processed data for chart,
 * table and other components in one api
 * @returns
 */
export function DefaultAutoRenderContent() {
  const ctx = useBenchmarkCommittedContext();
  const renderGroupId = useDashboardSelector((s) => s.renderGroupId);
  if (!ctx) return <LoadingPage />;

  let autoUIConfigs = ctx.dataRender.renders;

  // if renderGroupId is not main, we try to find the subSectionRenders, auto fallback to main render if nothing is found
  if (renderGroupId != "main" && ctx.dataRender?.subSectionRenders) {
    autoUIConfigs =
      ctx.dataRender.subSectionRenders[renderGroupId] ?? ctx.dataRender.renders;
  }

  return (
    <>
      <HighlightStyles />
      <Box>
        <Stack spacing={1}>
          <Typography variant="h2"> {ctx.config.raw.title} </Typography>
        </Stack>
        <Divider />
        <BackToMainButton />
        {autoUIConfigs?.map((autoUIConfig, index) => {
          const { Component } = getAutoRenderComponent(autoUIConfig);
          return (
            <Box key={index}>
              <Component config={autoUIConfig} />
            </Box>
          );
        })}
      </Box>
    </>
  );
}
