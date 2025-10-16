
import { Box, Stack } from "@mui/system";
import { HighlightStyles } from "components/benchmark/v3/components/common/highlight";
import { getAutoRenderComponent } from "components/benchmark/v3/configs/utils/autoRegistration";
import { Divider, Typography } from "@mui/material";
import LoadingPage from "components/common/LoadingPage";
import { useBenchmarkCommittedContext } from "lib/benchmark/api_helper/fe/hooks";

/**
 * The default fanout component fetches pre-processed data for chart,
 * table and other components in one api
 * @returns
 */
export function DefaultAutoRenderContent() {
  const ctx =  useBenchmarkCommittedContext();
  if (!ctx) return <LoadingPage />;
  const autoUIConfigs = ctx.dataRender.renders;

  return (
    <>
      <HighlightStyles />
      <Box>
        <Stack spacing={1}>
          <Typography variant="h2"> {ctx.config.raw.title} </Typography>
        </Stack>
        <Divider />
        {autoUIConfigs?.map((autoUIConfig, index) => {
          const { Component} = getAutoRenderComponent(autoUIConfig);
          return (
            <Box key={index}>
              <Component />
            </Box>
          );
        })}
      </Box>
    </>)
}
