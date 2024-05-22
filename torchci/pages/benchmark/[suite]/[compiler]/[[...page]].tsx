import dayjs from "dayjs";
import useSWR from "swr";
import { Grid, Skeleton, Stack, Typography, Divider } from "@mui/material";
import { useRouter } from "next/router";
import React from "react";
import { useState, useEffect } from "react";
import { RocksetParam } from "lib/rockset";
import { fetcher } from "lib/GeneralUtils";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import GranularityPicker from "components/GranularityPicker";
import { TimeRangePicker } from "../../../metrics";
import { CompilerPerformanceData } from "lib/types";
import CopyLink from "components/CopyLink";
import { BranchAndCommitPicker } from "components/benchmark/BranchAndCommitPicker";
import { MAIN_BRANCH, LAST_N_DAYS } from "components/benchmark/common";
import {
  DEFAULT_MODE,
  MODES,
  ModePicker,
  DTypePicker,
} from "components/benchmark/ModeAndDTypePicker";
import { augmentData } from "lib/benchmark/compilerUtils";
import { COMPILER_NAMES_TO_DISPLAY_NAMES } from "components/benchmark/compilers/common";
import { ModelPanel } from "components/benchmark/compilers/ModelPanel";
import { GraphPanel } from "components/benchmark/compilers/ModelGraphPanel";
import { BranchAndCommit } from "lib/types";
import { CommitPanel } from "components/benchmark/CommitPanel";
import { BenchmarkLogs } from "components/benchmark/compilers/BenchmarkLogs";

function Report({
  queryParams,
  startTime,
  stopTime,
  granularity,
  suite,
  mode,
  dtype,
  compiler,
  model,
  lBranchAndCommit,
  rBranchAndCommit,
}: {
  queryParams: RocksetParam[];
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  granularity: Granularity;
  suite: string;
  mode: string;
  dtype: string;
  compiler: string;
  model: string;
  lBranchAndCommit: BranchAndCommit;
  rBranchAndCommit: BranchAndCommit;
}) {
  const queryCollection = "inductor";
  const queryName = "compilers_benchmark_performance";

  const queryParamsWithL: RocksetParam[] = [
    {
      name: "branches",
      type: "string",
      value: lBranchAndCommit.branch,
    },
    {
      name: "commits",
      type: "string",
      value: lBranchAndCommit.commit,
    },
    {
      name: "getJobId",
      type: "bool",
      value: true,
    },
    ...queryParams,
  ];
  const lUrl = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithL)
  )}`;

  let { data: lData, error: _lError } = useSWR(lUrl, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });
  lData = augmentData(lData);
  lData = lData
    ? lData.filter((e: CompilerPerformanceData) => e.suite === suite)
    : lData;

  const queryParamsWithR: RocksetParam[] = [
    {
      name: "branches",
      type: "string",
      value: rBranchAndCommit.branch,
    },
    {
      name: "commits",
      type: "string",
      value: rBranchAndCommit.commit,
    },
    {
      name: "getJobId",
      type: "bool",
      value: true,
    },
    ...queryParams,
  ];
  const rUrl = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithR)
  )}`;

  let { data: rData, error: _rError } = useSWR(rUrl, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });
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
        workflowName={"inductor-a100-perf-nightly"}
      >
        <BenchmarkLogs workflowId={lData[0].workflow_id} />
      </CommitPanel>
      <GraphPanel
        queryParams={queryParams}
        granularity={granularity}
        compiler={compiler}
        model={model}
        branch={lBranchAndCommit.branch}
        lCommit={lBranchAndCommit.commit}
        rCommit={rBranchAndCommit.commit}
      />
      <ModelPanel
        startTime={startTime}
        stopTime={stopTime}
        granularity={granularity}
        suite={suite}
        mode={mode}
        dtype={dtype}
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

  // The dimensions to query Rockset
  const suite: string = (router.query.suite as string) ?? undefined;
  const compiler: string = (router.query.compiler as string) ?? undefined;
  const model: string = (router.query.model as string) ?? undefined;

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
  }, [defaultStartTime, defaultStopTime, router.asPath, router.query]);

  if (suite === undefined || compiler === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const queryParams: RocksetParam[] = [
    {
      name: "timezone",
      type: "string",
      value: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    {
      name: "startTime",
      type: "string",
      value: startTime,
    },
    {
      name: "stopTime",
      type: "string",
      value: stopTime,
    },
    {
      name: "granularity",
      type: "string",
      value: granularity,
    },
    {
      name: "mode",
      type: "string",
      value: mode,
    },
    {
      name: "compilers",
      type: "string",
      value: compiler,
    },
    {
      name: "dtypes",
      type: "string",
      value: dtype,
    },
  ];

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          TorchInductor Performance DashBoard (
          {COMPILER_NAMES_TO_DISPLAY_NAMES[compiler] || compiler})
        </Typography>
        <CopyLink
          textToCopy={
            `${baseUrl}?startTime=${encodeURIComponent(
              startTime.toString()
            )}&stopTime=${encodeURIComponent(
              stopTime.toString()
            )}&granularity=${granularity}&mode=${mode}&dtype=${dtype}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}` +
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
        <ModePicker mode={mode} setMode={setMode} setDType={setDType} />
        <DTypePicker dtype={dtype} setDType={setDType} />
        <BranchAndCommitPicker
          queryName={"compilers_benchmark_performance_branches"}
          queryCollection={"inductor"}
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
          queryName={"compilers_benchmark_performance_branches"}
          queryCollection={"inductor"}
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

      <Grid item xs={12}>
        <Report
          queryParams={queryParams}
          startTime={startTime}
          stopTime={stopTime}
          granularity={granularity}
          suite={suite}
          mode={mode}
          dtype={dtype}
          compiler={compiler}
          model={model}
          lBranchAndCommit={{ branch: lBranch, commit: lCommit }}
          rBranchAndCommit={{ branch: rBranch, commit: rCommit }}
        />
      </Grid>
    </div>
  );
}
