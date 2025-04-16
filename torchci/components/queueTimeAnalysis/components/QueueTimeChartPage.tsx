import { Grid2, Stack, styled, Typography } from "@mui/material";
import { useRouter } from "next/router";
import { useReducer, useState } from "react";

import { propsReducer } from "components/benchmark/llms/context/BenchmarkProps";
import LoadingPage from "components/LoadingPage";
import { ParsedUrlQuery } from "querystring";
import QueueTimeChartGroup from "./charts/QueueTimeChartGroup";
import QueueTimeSearchBar from "./QueueTimeSearchBar";

const FlexNoWrap = styled("div")({
  display: "flex",
  flexWrap: "nowrap",
});

export default function QueueTimeChart(urlQuery: ParsedUrlQuery) {
  const router = useRouter();
  const [routerReady, setRouterReady] = useState(false);
  const [props, dispatch] = useReducer(propsReducer, {});

  const params = {
    startTime: props.startDate?.utc().format("YYYY-MM-DDTHH:mm:ss"),
    endTime: props.endDate?.utc().format("YYYY-MM-DDTHH:mm:ss"),
    items: props.items ? props.items : [],
    repos: props.repos,
    granularity: props.granularity ? props.granularity : "",
  };

  if (!routerReady && router.isReady) {
    setRouterReady(true);
  }
  if (!routerReady) {
    return <LoadingPage />;
  }

  return (
    <div style={{ width: "2000px" }}>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          PyTorch Queue Time Analysis
        </Typography>
      </Stack>
      <Grid2 container spacing={2}>
        <div>
          <pre>{JSON.stringify(props, null)}</pre>
        </div>
        <FlexNoWrap>
          <div>
            <QueueTimeChartGroup props={props} />
          </div>
          <div>
            <QueueTimeSearchBar router={router} updateSearch={dispatch} />
          </div>
        </FlexNoWrap>
      </Grid2>
    </div>
  );
}
