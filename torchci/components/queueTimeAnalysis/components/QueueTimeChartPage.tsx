import { Grid2, Stack, styled, Typography } from "@mui/material";
import { useRouter } from "next/router";
import { useEffect, useReducer, useState } from "react";

import { propsReducer } from "components/benchmark/llms/context/BenchmarkProps";
import LoadingPage from "components/LoadingPage";
import dayjs from "dayjs";
import QueueTimeChartGroup from "./charts/QueueTimeChartGroup";
import QueueTimeSearchBar from "./searchBarItems/QueueTimeSearchBar";

const FlexNoWrap = styled("div")({
  display: "flex",
  flexWrap: "nowrap",
});

export default function QueueTimeChartPage() {
  const router = useRouter();
  const [routerReady, setRouterReady] = useState(false);
  const [props, dispatch] = useReducer(propsReducer, {});

  if (!routerReady && router.isReady) {
    setRouterReady(true);
  }
  if (!routerReady) {
    return <LoadingPage />;
  }

  return (
    <div style={{ width: "2000px" }}>
      <Stack spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          PyTorch Queue Time Analysis
        </Typography>
      </Stack>
      <Stack sx={{ mb: 2, fontSize: 15 }}>
        <Typography variant="caption" color="textSecondary">
          * All datetime values are in UTC. <Clock />
        </Typography>
      </Stack>
      <Grid2 container spacing={2}>
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

function Clock() {
  const [now, setNow] = useState(dayjs());

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(dayjs()); // update to current local time
    }, 6000);

    return () => clearInterval(interval); // cleanup on unmount
  }, []);

  return (
    <span>
      <span>
        Local: {now.format("YYYY-MM-DD HH:mm:ss")}, UTC Time:{" "}
        {now.utc().format("YYYY-MM-DD HH:mm:ss")}
      </span>
    </span>
  );
}
