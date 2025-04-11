import { Divider, Stack, Typography } from "@mui/material";
import { RepositoryBranchCommitPicker } from "components/benchmark/RepositoryPicker";
import { DEFAULT_TRITON_REPOSITORY, LAST_N_DAYS, MAIN_BRANCH } from "components/benchmark/common";
import { DEFAULT_HIGHLIGHT_KEY } from "components/benchmark/compilers/common";
import { TimeSeriesGraphReport } from "components/benchmark/tritonbench/TimeSeries";
import CopyLink from "components/CopyLink";
import GranularityPicker from "components/GranularityPicker";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { TimeRangePicker } from "../metrics";

export default function Page() {
  const router = useRouter();

  const defaultStartTime = dayjs().subtract(LAST_N_DAYS, "day");
  const [startTime, setStartTime] = useState(defaultStartTime);
  const defaultStopTime = dayjs();
  const [stopTime, setStopTime] = useState(defaultStopTime);
  const [timeRange, setTimeRange] = useState<number>(LAST_N_DAYS);
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [granularity, setGranularity] = useState<Granularity>("hour");
  const [lRepository, setLRepository] = useState<string>(DEFAULT_TRITON_REPOSITORY);
  const [lBranch, setLBranch] = useState<string>(MAIN_BRANCH);
  const [lCommit, setLCommit] = useState<string>("");
  const [rRepository, setRRepository] = useState<string>(DEFAULT_TRITON_REPOSITORY);
  const [rBranch, setRBranch] = useState<string>(MAIN_BRANCH);
  const [rCommit, setRCommit] = useState<string>("");
  const [highlightKey, setHighlightKey] = useState<string>(
    DEFAULT_HIGHLIGHT_KEY
  );

  // Set the dropdown value what is in the param
  useEffect(() => {
    const startTime: string = (router.query.startTime as string) ?? undefined;
    if (startTime !== undefined) {
      setStartTime(dayjs(startTime));

      if (dayjs(startTime).valueOf() !== defaultStartTime.valueOf()) {
        setTimeRange(-1);
      }
    }

    const stopTime: string = (router.query.stopTime as string) ?? undefined;
    if (stopTime !== undefined) {
      setStopTime(dayjs(stopTime));

      if (dayjs(stopTime).valueOf() !== defaultStopTime.valueOf()) {
        setTimeRange(-1);
      }
    }

    const granularity: Granularity =
      (router.query.granularity as Granularity) ?? undefined;
    if (granularity !== undefined) {
      setGranularity(granularity);
    }

    const suite: string = (router.query.suite as string) ?? undefined;

    setBaseUrl(
      `${window.location.protocol}//${
        window.location.host
      }${router.asPath.replace(/\?.+/, "")}`
    );
  }, [router.query]);

  const queryParams: { [key: string]: any } = {
    commits: [],
    compilers: [],
    getJobId: false,
    granularity: granularity,
    benchmark_name: "compile_time",
    startTime: dayjs(startTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: dayjs(stopTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    workflowId: 0,
  };

  return (
    <>
      <div>
        <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
          <Typography fontSize={"2rem"} fontWeight={"bold"}>
            Triton Compile Time DashBoard
          </Typography>
          <CopyLink textToCopy={`${baseUrl}`} />
        </Stack>
        <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
          <TimeRangePicker
            startTime={startTime}
            setStartTime={setStartTime}
            stopTime={stopTime}
            setStopTime={setStopTime}
            timeRange={timeRange}
            setTimeRange={setTimeRange}
            setGranularity={setGranularity}
          />
          <GranularityPicker
            granularity={granularity}
            setGranularity={setGranularity}
          />
          <RepositoryBranchCommitPicker
            queryName={"tritonbench_benchmark_branches"}
            queryParams={queryParams}
            repository={lRepository}
            setRepository={setLRepository}
            branch={lBranch}
            setBranch={setLBranch}
            commit={lCommit}
            setCommit={setLCommit}
            titlePrefix={"Base"}
            fallbackIndex={-1} // Default to the next to latest in the window
            timeRange={timeRange}
            highlightConfig={{
              keys:
                highlightKey === DEFAULT_HIGHLIGHT_KEY ? [] : [highlightKey],
              highlightColor: "yellow",
            }}
          />
          <Divider orientation="vertical" flexItem>
            &mdash;Diff→
          </Divider>
          <RepositoryBranchCommitPicker
            queryName={"tritonbench_benchmark_branches"}
            queryParams={queryParams}
            repository={rRepository}
            setRepository={setRRepository}
            branch={rBranch}
            setBranch={setRBranch}
            commit={rCommit}
            setCommit={setRCommit}
            titlePrefix={"New"}
            fallbackIndex={-1} // Default to the next to latest in the window
            timeRange={timeRange}
            highlightConfig={{
              keys:
                highlightKey === DEFAULT_HIGHLIGHT_KEY ? [] : [highlightKey],
              highlightColor: "yellow",
            }}
          />
        </Stack>
        <TimeSeriesGraphReport
          queryParams={queryParams}
          granularity={granularity}
          lBranchAndCommit={{ branch: lBranch, commit: lCommit }}
          rBranchAndCommit={{ branch: rBranch, commit: rCommit }}
        />
      </div>
    </>
  );
}
