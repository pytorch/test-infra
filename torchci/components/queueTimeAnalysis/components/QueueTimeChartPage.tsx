import { Stack, styled, Tooltip, Typography } from "@mui/material";
import { useRouter } from "next/router";
import { useEffect, useReducer, useState } from "react";

import { propsReducer } from "components/benchmark/llms/context/BenchmarkProps";
import { UMCopyLink } from "components/uiModules/UMCopyLink";
import dayjs from "dayjs";
import QueueTimeCharts from "./charts/QueueTimeCharts";
import DebugToggle from "./DebugToggle";
import QueueTimeSearchBar from "./searchBarItems/QueueTimeSearchBar";
const FlexNoWrap = styled("div")({
  display: "flex",
  flexWrap: "nowrap",
});

import InfoIcon from "@mui/icons-material/Info"; // Add this import statement
import LoadingPage from "components/common/LoadingPage";
import QueueDataExplanation from "./QueueDataExplanation";

export default function QueueTimeChartPage() {
  const router = useRouter();
  const [routerReady, setRouterReady] = useState(false);
  const [props, dispatch] = useReducer(propsReducer, {});

  const [searchBarOpen, setSearchBarOpen] = useState(true);

  if (!routerReady && router.isReady) {
    setRouterReady(true);
  }
  if (!routerReady) {
    return <LoadingPage />;
  }

  return (
    <div>
      <Stack spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          PyTorch Queue Time Analysis
          <UMCopyLink params={props} />
        </Typography>
      </Stack>
      <Stack sx={{ mb: 2, fontSize: 15 }}>
        <Typography variant="caption" color="textSecondary">
          * All datetime values are in UTC. <Clock />
        </Typography>
        <Typography variant="caption" color="textSecondary">
          <span>
            {" "}
            * Data is collected every 30 minutes, including all jobs in queue at
            that time.{" "}
          </span>
          <Tooltip title={<QueueDataExplanation />}>
            <InfoIcon fontSize="small" />
          </Tooltip>
        </Typography>
      </Stack>
      <div>
        <FlexNoWrap>
          <div>
            <QueueTimeCharts
              props={props}
              width={searchBarOpen ? "80vw" : "100vw"}
            />
            <DebugToggle info={props} sx={{ width: "30vw" }} />
          </div>
          <div>
            <QueueTimeSearchBar
              router={router}
              updateSearch={dispatch}
              setToggle={setSearchBarOpen}
            />
          </div>
        </FlexNoWrap>
      </div>
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
