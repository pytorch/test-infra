import { Divider, Skeleton, Stack, Typography } from "@mui/material";
import { BranchAndCommitPicker } from "components/benchmark/BranchAndCommitPicker";
import { CommitPanel } from "components/benchmark/CommitPanel";
import {
  DEFAULT_REPO_NAME,
  LAST_N_DAYS,
  MAIN_BRANCH,
} from "components/benchmark/common";
import { BenchmarkLogs } from "components/benchmark/compilers/BenchmarkLogs";
import {
  DEFAULT_DEVICE_NAME,
  DEFAULT_HIGHLIGHT_KEY,
  DISPLAY_KEYS_TO_HIGHLIGHT,
  DISPLAY_NAMES_TO_DEVICE_NAMES,
  DISPLAY_NAMES_TO_WORKFLOW_NAMES,
  DTYPES,
} from "components/benchmark/compilers/common";
import CompilerGraphGroup from "components/benchmark/compilers/CompilerGraphGroup";
import { SUITES } from "components/benchmark/compilers/SuitePicker";
import { SummaryPanel } from "components/benchmark/compilers/SummaryPanel";
import {
  DEFAULT_MODE,
  DTypePicker,
  ModePicker,
  MODES,
} from "components/benchmark/ModeAndDTypePicker";
import CopyLink from "components/CopyLink";
import GranularityPicker from "components/GranularityPicker";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { augmentData } from "lib/benchmark/compilerUtils";
import { fetcher } from "lib/GeneralUtils";
import { BranchAndCommit } from "lib/types";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { COMPILER_SUITES_MAP } from "../../lib/benchmark/compliers/CompilerSuites";
import { TimeRangePicker } from "../metrics";
const HardCodedHightlightConfig = {
  keys: ["max_autotune"],
  highlightColor: "yellow",
};

function Report({
  queryParams,
  startTime,
  stopTime,
  granularity,
  mode,
  dtype,
  deviceName,
  lBranchAndCommit,
  rBranchAndCommit,
}: {
  queryParams: { [key: string]: any };
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  granularity: Granularity;
  mode: string;
  dtype: string;
  deviceName: string;
  lBranchAndCommit: BranchAndCommit;
  rBranchAndCommit: BranchAndCommit;
}) {
  const queryName = "compilers_benchmark_performance";
  const queryParamsWithL: { [key: string]: any } = {
    ...queryParams,
    branches: [lBranchAndCommit.branch],
    commits: lBranchAndCommit.commit ? [lBranchAndCommit.commit] : [],
  };
  const lUrl = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithL)
  )}`;

  let { data: lData, error: _lError } = useSWR(lUrl, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });
  lData = augmentData(lData);

  const queryParamsWithR: { [key: string]: any } = {
    ...queryParams,
    branches: [rBranchAndCommit.branch],
    commits: rBranchAndCommit.commit ? [rBranchAndCommit.commit] : [],
  };
  const rUrl = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithR)
  )}`;

  let { data: rData, error: _rError } = useSWR(rUrl, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });
  rData = augmentData(rData);

  if (
    lData === undefined ||
    lData.length === 0 ||
    rData === undefined ||
    rData.length === 0
  ) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  return (
    <div>
      <CommitPanel
        repoName={DEFAULT_REPO_NAME}
        lBranchAndCommit={{
          ...lBranchAndCommit,
          date: lData[0].granularity_bucket,
        }}
        rBranchAndCommit={{
          ...rBranchAndCommit,
          date:
            rData !== undefined && rData.length !== 0
              ? rData[0].granularity_bucket
              : undefined,
        }}
        workflowName={
          DISPLAY_NAMES_TO_WORKFLOW_NAMES[deviceName] ??
          "inductor-a100-perf-nightly"
        }
      >
        <BenchmarkLogs workflowId={lData[0].workflow_id} />
      </CommitPanel>
      <SummaryPanel
        dashboard={"torchinductor"}
        startTime={startTime}
        stopTime={stopTime}
        granularity={granularity}
        mode={mode}
        dtype={dtype}
        deviceName={deviceName}
        lPerfData={{
          ...lBranchAndCommit,
          data: lData,
        }}
        rPerfData={{
          ...rBranchAndCommit,
          data: rData,
        }}
        all_suites={SUITES}
      />
      {Array.from(Object.values(COMPILER_SUITES_MAP)).map((suiteConfig) => {
        return (
          suiteConfig.showGraph && (
            <div key={suiteConfig.id}>
              <CompilerGraphGroup
                dashboard={"torchinductor"}
                suiteConfig={suiteConfig}
                queryParams={queryParams}
                granularity={granularity}
                lBranchAndCommit={lBranchAndCommit}
                rBranchAndCommit={rBranchAndCommit}
              />
            </div>
          )
        );
      })}
    </div>
  );
}

export default function Page() {
  const router = useRouter();

  const defaultStartTime = dayjs().subtract(LAST_N_DAYS, "day");
  const [startTime, setStartTime] = useState(defaultStartTime);
  const defaultStopTime = dayjs();
  const [stopTime, setStopTime] = useState(defaultStopTime);
  const [timeRange, setTimeRange] = useState<number>(LAST_N_DAYS);

  const [granularity, setGranularity] = useState<Granularity>("hour");
  const [mode, setMode] = useState<string>(DEFAULT_MODE);
  const [dtype, setDType] = useState<string>(MODES[DEFAULT_MODE]);
  const [lBranch, setLBranch] = useState<string>(MAIN_BRANCH);
  const [lCommit, setLCommit] = useState<string>("");
  const [rBranch, setRBranch] = useState<string>(MAIN_BRANCH);
  const [rCommit, setRCommit] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [deviceName, setDeviceName] = useState<string>(DEFAULT_DEVICE_NAME);
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

    const mode: string = (router.query.mode as string) ?? undefined;
    if (mode !== undefined) {
      setMode(mode);
    }

    const dtype: string = (router.query.dtype as string) ?? undefined;
    if (dtype !== undefined) {
      setDType(dtype);
    }

    const deviceName: string = (router.query.deviceName as string) ?? undefined;
    if (deviceName !== undefined) {
      setDeviceName(deviceName);
    }

    const lBranch: string = (router.query.lBranch as string) ?? undefined;
    if (lBranch !== undefined) {
      setLBranch(lBranch);
    }

    const lCommit: string = (router.query.lCommit as string) ?? undefined;
    if (lCommit !== undefined) {
      setLCommit(lCommit);
    }

    const rBranch: string = (router.query.rBranch as string) ?? undefined;
    if (rBranch !== undefined) {
      setRBranch(rBranch);
    }

    const rCommit: string = (router.query.rCommit as string) ?? undefined;
    if (rCommit !== undefined) {
      setRCommit(rCommit);
    }

    setBaseUrl(
      `${window.location.protocol}//${
        window.location.host
      }${router.asPath.replace(/\?.+/, "")}`
    );
  }, [router.query]);

  const queryParams: { [key: string]: any } = {
    commits: [],
    compilers: [],
    device: DISPLAY_NAMES_TO_DEVICE_NAMES[deviceName],
    dtypes: dtype,
    getJobId: false,
    granularity: granularity,
    mode: mode,
    startTime: dayjs(startTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: dayjs(stopTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    suites: Object.keys(SUITES),
    workflowId: 0,
  };

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          TorchInductor Performance DashBoard
        </Typography>
        <CopyLink
          textToCopy={`${baseUrl}?dashboard=torchinductor&startTime=${encodeURIComponent(
            startTime.toString()
          )}&stopTime=${encodeURIComponent(
            stopTime.toString()
          )}&granularity=${granularity}&mode=${mode}&dtype=${dtype}&deviceName=${encodeURIComponent(
            deviceName
          )}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}`}
        />
      </Stack>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <DTypePicker
          dtype={highlightKey}
          setDType={setHighlightKey}
          dtypes={Object.values(DISPLAY_KEYS_TO_HIGHLIGHT)}
          label={"Highlight"}
        ></DTypePicker>
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
        <ModePicker mode={mode} setMode={setMode} setDType={setDType} />
        <DTypePicker
          dtype={dtype}
          setDType={setDType}
          dtypes={DTYPES}
          label={"Precision"}
        />
        <DTypePicker
          dtype={deviceName}
          setDType={setDeviceName}
          dtypes={Object.keys(DISPLAY_NAMES_TO_DEVICE_NAMES)}
          label={"Device"}
        />
        <BranchAndCommitPicker
          queryName={"compilers_benchmark_performance_branches"}
          queryParams={queryParams}
          branch={rBranch}
          setBranch={setRBranch}
          commit={rCommit}
          setCommit={setRCommit}
          titlePrefix={"Base"}
          fallbackIndex={-1} // Default to the next to latest in the window
          timeRange={timeRange}
          highlightConfig={{
            keys: highlightKey === DEFAULT_HIGHLIGHT_KEY ? [] : [highlightKey],
            highlightColor: "yellow",
          }}
        />
        <Divider orientation="vertical" flexItem>
          &mdash;Diff→
        </Divider>
        <BranchAndCommitPicker
          queryName={"compilers_benchmark_performance_branches"}
          queryParams={queryParams}
          branch={lBranch}
          setBranch={setLBranch}
          commit={lCommit}
          setCommit={setLCommit}
          titlePrefix={"New"}
          fallbackIndex={0} // Default to the latest commit
          timeRange={timeRange}
          highlightConfig={{
            keys: highlightKey === DEFAULT_HIGHLIGHT_KEY ? [] : [highlightKey],
            highlightColor: "yellow",
          }}
        />
      </Stack>
      <Report
        queryParams={queryParams}
        startTime={startTime}
        stopTime={stopTime}
        granularity={granularity}
        mode={mode}
        dtype={dtype}
        deviceName={deviceName}
        lBranchAndCommit={{ branch: lBranch, commit: lCommit }}
        rBranchAndCommit={{ branch: rBranch, commit: rCommit }}
      />
    </div>
  );
}
