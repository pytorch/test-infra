import { Divider, Grid2, Skeleton, Stack, Typography } from "@mui/material";
import { BranchAndCommitPicker } from "components/benchmark/BranchAndCommitPicker";
import { CommitPanel } from "components/benchmark/CommitPanel";
import {
  DASHBOARD_NAME_MAP,
  DASHBOARD_QUERY_MAP,
  DEFAULT_REPO_NAME,
  LAST_N_DAYS,
  MAIN_BRANCH,
} from "components/benchmark/common";
import { BenchmarkLogs } from "components/benchmark/compilers/BenchmarkLogs";
import {
  COMPILER_NAMES_TO_DISPLAY_NAMES,
  DEFAULT_DEVICE_NAME,
  DISPLAY_NAMES_TO_DEVICE_NAMES,
  DISPLAY_NAMES_TO_WORKFLOW_NAMES,
  DTYPES,
} from "components/benchmark/compilers/common";
import { GraphPanel } from "components/benchmark/compilers/ModelGraphPanel";
import { ModelPanel } from "components/benchmark/compilers/ModelPanel";
import {
  DEFAULT_MODE,
  DTypePicker,
  ModePicker,
  MODES,
} from "components/benchmark/ModeAndDTypePicker";
import { QUANTIZATIONS } from "components/benchmark/torchao/common";
import CopyLink from "components/CopyLink";
import GranularityPicker from "components/GranularityPicker";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import {
  augmentData,
  convertToCompilerPerformanceData,
} from "lib/benchmark/compilerUtils";
import { fetcher } from "lib/GeneralUtils";
import { BranchAndCommit, CompilerPerformanceData } from "lib/types";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { TimeRangePicker } from "../../../metrics";

function Report({
  dashboard,
  queryName,
  queryParams,
  startTime,
  stopTime,
  granularity,
  suite,
  mode,
  dtype,
  deviceName,
  compiler,
  model,
  lBranchAndCommit,
  rBranchAndCommit,
}: {
  dashboard: string;
  queryName: string;
  queryParams: { [key: string]: any };
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  granularity: Granularity;
  suite: string;
  mode: string;
  dtype: string;
  deviceName: string;
  compiler: string;
  model: string;
  lBranchAndCommit: BranchAndCommit;
  rBranchAndCommit: BranchAndCommit;
}) {
  const queryParamsWithL: { [key: string]: any } = {
    ...queryParams,
    branches: [lBranchAndCommit.branch],
    commits: [lBranchAndCommit.commit],
    getJobId: true,
  };
  const lUrl = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithL)
  )}`;

  let { data: lData, error: _lError } = useSWR(lUrl, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });
  // TODO (huydhn): Remove this once TorchInductor dashboard is migrated to the
  // new database schema
  lData =
    dashboard === "torchao" ? convertToCompilerPerformanceData(lData) : lData;
  lData = augmentData(lData);
  lData = lData
    ? lData.filter((e: CompilerPerformanceData) => e.suite === suite)
    : lData;

  const queryParamsWithR: { [key: string]: any } = {
    ...queryParams,
    branches: [rBranchAndCommit.branch],
    commits: [rBranchAndCommit.commit],
    getJobId: true,
  };
  const rUrl = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithR)
  )}`;

  let { data: rData, error: _rError } = useSWR(rUrl, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });
  // TODO (huydhn): Remove this once TorchInductor dashboard is migrated to the
  // new database schema
  rData =
    dashboard === "torchao" ? convertToCompilerPerformanceData(rData) : rData;
  rData = augmentData(rData);
  rData = rData
    ? rData.filter((e: CompilerPerformanceData) => e.suite === suite)
    : rData;

  if (lData === undefined || lData.length === 0) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  return (
    <div>
      <CommitPanel
        repoName={
          dashboard === "torchao" ? "pytorch/benchmark" : DEFAULT_REPO_NAME
        }
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
          dashboard === "torchao"
            ? "Torchao nightly workflow (A100)".toLowerCase()
            : DISPLAY_NAMES_TO_WORKFLOW_NAMES[deviceName]
        }
      >
        <BenchmarkLogs workflowId={lData[0].workflow_id} />
      </CommitPanel>
      <GraphPanel
        queryName={queryName}
        queryParams={queryParams}
        granularity={granularity}
        compiler={compiler}
        model={model}
        branch={lBranchAndCommit.branch}
        lCommit={lBranchAndCommit.commit}
        rCommit={rBranchAndCommit.commit}
      />
      <ModelPanel
        dashboard={dashboard}
        startTime={startTime}
        stopTime={stopTime}
        granularity={granularity}
        suite={suite}
        mode={mode}
        dtype={dtype}
        deviceName={deviceName}
        compiler={compiler}
        model={model}
        lPerfData={{
          ...lBranchAndCommit,
          data: lData,
        }}
        rPerfData={{
          ...rBranchAndCommit,
          data: rData,
        }}
      />
    </div>
  );
}

export default function Page() {
  const router = useRouter();

  // The dimensions to query
  const suite: string = (router.query.suite as string) ?? undefined;
  const compiler: string = (router.query.compiler as string) ?? undefined;
  const model: string = (router.query.model as string) ?? undefined;
  const dashboard: string =
    (router.query.dashboard as string) ?? "torchinductor";
  const queryName: string =
    DASHBOARD_QUERY_MAP[dashboard] ?? "compilers_benchmark_performance";
  const branchQueryName = queryName + "_branches";

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

  if (suite === undefined || compiler === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  // TODO (huydhn): Remove this once TorchInductor dashboard is migrated to the
  // new database schema
  const queryParams: { [key: string]: any } =
    dashboard === "torchao"
      ? {
          branches: [],
          commits: [],
          compilers: [compiler],
          device: DISPLAY_NAMES_TO_DEVICE_NAMES[deviceName],
          dtypes: [dtype],
          granularity: granularity,
          mode: mode,
          repo: "pytorch/benchmark",
          startTime: dayjs(startTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
          stopTime: dayjs(stopTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
          suites: [],
          workflowId: 0,
        }
      : {
          commits: [],
          compilers: [compiler],
          device: DISPLAY_NAMES_TO_DEVICE_NAMES[deviceName],
          dtypes: dtype,
          getJobId: false,
          granularity: granularity,
          mode: mode,
          startTime: dayjs(startTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
          stopTime: dayjs(stopTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
          suites: [],
          workflowId: 0,
        };

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          {DASHBOARD_NAME_MAP[dashboard]} Performance DashBoard (
          {COMPILER_NAMES_TO_DISPLAY_NAMES[compiler] || compiler})
        </Typography>
        <CopyLink
          textToCopy={
            `${baseUrl}?dashboard=${dashboard}&startTime=${encodeURIComponent(
              startTime.toString()
            )}&stopTime=${encodeURIComponent(
              stopTime.toString()
            )}&granularity=${granularity}&mode=${mode}&dtype=${dtype}&deviceName=${encodeURIComponent(
              deviceName
            )}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}` +
            (model === undefined ? "" : `&model=${model}`)
          }
        />
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
        {dashboard === "torchao" && (
          <DTypePicker
            dtype={mode}
            setDType={setMode}
            dtypes={Object.keys(MODES)}
            label={"Mode"}
          />
        )}
        {dashboard === "torchinductor" && (
          <ModePicker mode={mode} setMode={setMode} setDType={setDType} />
        )}
        <DTypePicker
          dtype={dtype}
          setDType={setDType}
          dtypes={dashboard === "torchao" ? QUANTIZATIONS : DTYPES}
          label={dashboard === "torchao" ? "Quantization" : "Precision"}
        />
        <DTypePicker
          dtype={deviceName}
          setDType={setDeviceName}
          dtypes={Object.keys(DISPLAY_NAMES_TO_DEVICE_NAMES)}
          label={"Device"}
        />
        <BranchAndCommitPicker
          queryName={branchQueryName}
          branch={rBranch}
          setBranch={setRBranch}
          commit={rCommit}
          setCommit={setRCommit}
          queryParams={queryParams}
          titlePrefix={"Base"}
          fallbackIndex={-1} // Default to the next to latest in the window
          timeRange={timeRange}
        />
        <Divider orientation="vertical" flexItem>
          &mdash;Diff→
        </Divider>
        <BranchAndCommitPicker
          queryName={branchQueryName}
          branch={lBranch}
          setBranch={setLBranch}
          commit={lCommit}
          setCommit={setLCommit}
          queryParams={queryParams}
          titlePrefix={"New"}
          fallbackIndex={0} // Default to the latest commit
          timeRange={timeRange}
        />
      </Stack>

      <Grid2 size={{ xs: 12 }}>
        <Report
          dashboard={dashboard}
          queryName={queryName}
          queryParams={queryParams}
          startTime={startTime}
          stopTime={stopTime}
          granularity={granularity}
          suite={suite}
          mode={mode}
          dtype={dtype}
          deviceName={deviceName}
          compiler={compiler}
          model={model}
          lBranchAndCommit={{ branch: lBranch, commit: lCommit }}
          rBranchAndCommit={{ branch: rBranch, commit: rCommit }}
        />
      </Grid2>
    </div>
  );
}
