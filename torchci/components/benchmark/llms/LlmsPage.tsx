import { Divider, Stack, Typography } from "@mui/material";
import { BranchAndCommitPicker } from "components/benchmark/BranchAndCommitPicker";
import {
  DEFAULT_REPO_NAME,
  LAST_N_DAYS,
  MAIN_BRANCH,
} from "components/benchmark/common";
import {
  ARCH_NAMES,
  DEFAULT_ARCH_NAME,
  DEFAULT_BACKEND_NAME,
  DEFAULT_DEVICE_NAME,
  DEFAULT_DTYPE_NAME,
  DEFAULT_MODE_NAME,
  DEFAULT_MODEL_NAME,
  EXCLUDED_METRICS,
  REPO_TO_BENCHMARKS,
} from "components/benchmark/llms/components/common";
import { DTypePicker } from "components/benchmark/ModeAndDTypePicker";
import CopyLink from "components/CopyLink";
import GranularityPicker from "components/GranularityPicker";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { TORCHAO_BASELINE } from "lib/benchmark/llms/aoUtils";
import { fetcher } from "lib/GeneralUtils";
import _, { cloneDeep, set } from "lodash";
import { NextRouter, useRouter } from "next/router";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { TimeRangePicker } from "../../../pages/metrics";
import LLMsReport from "./components/LlmsReport";
import LoadingPage from "components/LoadingPage";
import LlmsDropdowns from "./components/LlmsDropdowns";
import { LlmsGraphPanelProps } from "./common";

export interface LlmsGraphPanelProps {
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  timeRange: number;
  repoName: string;
  benchmarkName: string;
  modelName: string;
  backendName: string;
  modeName: string;
  dtypeName: string;
  deviceName: string;
  archName: string;
  granularity: Granularity;
}

/**
 * @returns Main page for the LLMs dashboard
 * the page is routed in pagesM/bencmark/llms.tsx
 */
export default function LlmsPage() {
  const router = useRouter();
  const defaultStartTime = dayjs().subtract(LAST_N_DAYS, "day");
  const defaultStopTime = dayjs();

  const [props, setProps] = useState<LlmsGraphPanelProps>({
    startTime: defaultStartTime,
    stopTime: defaultStopTime,
    timeRange: LAST_N_DAYS,
    repoName: DEFAULT_REPO_NAME,
    benchmarkName: "",
    modelName: DEFAULT_MODEL_NAME,
    backendName: DEFAULT_BACKEND_NAME,
    modeName: DEFAULT_MODE_NAME,
    dtypeName: DEFAULT_DTYPE_NAME,
    deviceName: DEFAULT_DEVICE_NAME,
    archName: DEFAULT_ARCH_NAME,
    granularity: "day",
   });

  const [timeRange, setTimeRange] = useState<number>(LAST_N_DAYS);
  const [lBranch, setLBranch] = useState<string>(MAIN_BRANCH);
  const [lCommit, setLCommit] = useState<string>("");
  const [rBranch, setRBranch] = useState<string>(MAIN_BRANCH);
  const [rCommit, setRCommit] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState<string>("");

  function resetProps(router:NextRouter, prevProps: LlmsGraphPanelProps){
    const newProps: LlmsGraphPanelProps= cloneDeep(prevProps);
    const startTime: string = (router.query.startTime as string) ?? undefined;
    if (startTime !== undefined) {
      newProps.startTime = dayjs(startTime);
      if (dayjs(startTime).valueOf() !== defaultStartTime.valueOf()) {
        newProps.timeRange = -1;
      }
    }
    const stopTime: string = (router.query.stopTime as string) ?? undefined;
    if (stopTime !== undefined) {
      newProps.stopTime = dayjs(stopTime);
      if (dayjs(stopTime).valueOf() !== defaultStopTime.valueOf()) {
        newProps.timeRange = -1;
      }
    }

    const granularity: Granularity =
      (router.query.granularity as Granularity) ?? undefined;
    if (granularity !== undefined) {
      newProps.granularity = granularity;
    }

    const repoName: string = (router.query.repoName as string) ?? undefined;
    if (repoName !== undefined) {
      newProps.repoName = repoName;
    }

    const benchmarkName: string =
      (router.query.benchmarkName as string) ?? undefined;
    if (benchmarkName != undefined) {
      newProps.benchmarkName = benchmarkName;
    }

    const modelName: string = (router.query.modelName as string) ?? undefined;
    if (modelName !== undefined) {
      newProps.modelName = modelName;
    }

    const backendName: string =
      (router.query.backendName as string) ?? undefined;
    if (backendName !== undefined) {
      newProps.backendName = backendName;
    }

    const modeName: string = (router.query.modeName as string) ?? undefined;
    if (modeName !== undefined) {
      newProps.modeName = modeName;
    }

    const dtypeName: string = (router.query.dtypeName as string) ?? undefined;
    if (dtypeName !== undefined) {
      newProps.dtypeName = dtypeName;
    }

    const deviceName: string = (router.query.deviceName as string) ?? undefined;
    if (deviceName !== undefined) {
      newProps.deviceName = deviceName;
    }

    // Set the default arch to Android for ExecuTorch as it has only 2 options Android and iOS
    const archName: string = (router.query.archName as string) ?? undefined;
    if (archName !== undefined) {
      newProps.archName = archName;
    }
    return newProps;
  }

  // Set the dropdown value what is in the param
  useEffect(() => {
    const newProps = resetProps(router, props);
    setProps(newProps);

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

  const queryName = "oss_ci_benchmark_names";
  const queryParams = {
    arch: props.archName === DEFAULT_ARCH_NAME ? "" : props.archName,
    device: props.deviceName === DEFAULT_DEVICE_NAME ? "" : props.deviceName,
    mode: props.modeName === DEFAULT_MODE_NAME ? "" : props.modeName,
    dtypes:
    props.dtypeName === DEFAULT_DTYPE_NAME
        ? []
        : props.repoName !== "pytorch/ao"
        ? [props.dtypeName]
        : [props.dtypeName, TORCHAO_BASELINE],
    excludedMetrics: EXCLUDED_METRICS,
    benchmarks: props.benchmarkName ? [props.benchmarkName] : REPO_TO_BENCHMARKS[props.repoName],
    granularity: props.granularity,
    models: props.modelName === DEFAULT_MODEL_NAME ? [] : [props.modelName],
    backends: props.backendName === DEFAULT_BACKEND_NAME ? [] : [props.backendName],
    repo: props.repoName,
    startTime: dayjs(props.startTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: dayjs(props.stopTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
  };

  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data,isLoading } = useSWR(url, fetcher, {
    // no need
    refreshInterval: 60 * 60 * 1000, // refresh every
  });

  function formLink(props: LlmsGraphPanelProps, baseUrl:string) {
    return (
      <CopyLink
            textToCopy={`${baseUrl}?startTime=${encodeURIComponent(
              props.startTime.toString()
            )}&stopTime=${encodeURIComponent(
              props.stopTime.toString()
            )}&granularity=${props.granularity}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}&repoName=${encodeURIComponent(
              props.repoName
            )}&benchmarkName=${encodeURIComponent(
              props.benchmarkName
            )}&modelName=${encodeURIComponent(
              props.modelName
            )}&backendName=${encodeURIComponent(
              props.backendName
            )}&modeName=${encodeURIComponent(
              props.modeName
            )}&dtypeName=${encodeURIComponent(
              props.dtypeName
            )}&deviceName=${encodeURIComponent(
              props.deviceName
            )}&archName=${encodeURIComponent(props.archName)}`}
          />
    )
  }
  if (isLoading){
    return (
      <LoadingPage />
    )
  }

  if (data === undefined || data.length === 0) {
    return (
      <div>
        <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
          <Typography fontSize={"2rem"} fontWeight={"bold"}>
            {props.benchmarkName ? props.benchmarkName : REPO_TO_BENCHMARKS[props.repoName]}{" "}
            dashboard
          </Typography>
          {formLink(props,baseUrl)}
        </Stack>
        <Stack>
          <>
            Found no records for{" "}
            {(props.benchmarkName
              ? [props.benchmarkName]
              : REPO_TO_BENCHMARKS[props.repoName]
            ).join(", ")}
            , please wait a min or select different time range
          </>
        </Stack>
      </div>
    );
  }

  const modelNames: string[] = [
    DEFAULT_MODEL_NAME,
    ...(_.uniq(data.map((r: any) => r.model)) as string[]),
  ];
  const backendNames: string[] = _.compact([
    DEFAULT_BACKEND_NAME,
    ...(_.uniq(data.map((r: any) => r.backend)) as string[]),
  ]);
  const deviceNames: string[] = [
    DEFAULT_DEVICE_NAME,
    ...(_.uniq(data.map((r: any) => `${r.device} (${r.arch})`)) as string[]),
  ];
  const modeNames: string[] = _.compact([
    DEFAULT_MODE_NAME,
    ...(_.uniq(data.map((r: any) => r.mode)) as string[]),
  ]);
  const dtypeNames: string[] = _.compact([
    DEFAULT_DTYPE_NAME,
    ...(_.uniq(data.map((r: any) => r.dtype)) as string[]),
  ]);
  const metricNames: string[] = _.uniq(data.map((r: any) => r.metric));

  const config = {
    modeNames,
    backendNames,
    deviceNames,
    modelNames,
    dtypeNames,
  }


  function getBenchMarkName(benchmarkName: string | any) {
    return (
      <Typography fontSize={"2rem"} fontWeight={"bold"}>
      {props.benchmarkName ? props.benchmarkName : REPO_TO_BENCHMARKS[props.repoName]}{" "}
      dashboard
    </Typography>
    )
  }
  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        {getBenchMarkName(props.benchmarkName)}
        {formLink(props,baseUrl)}
      </Stack>
      <LlmsDropdowns
      setProps={function (props: LlmsGraphPanelProps): void {
        setProps(props);
      } }
      props={props}
      optionListMap={config} />

      <Stack>
      <BranchAndCommitPicker
          queryName={"oss_ci_benchmark_branches"}
          queryParams={queryParams}
          branch={lBranch}
          setBranch={setLBranch}
          commit={lCommit}
          setCommit={setLCommit}
          titlePrefix={"Base"}
          fallbackIndex={-1} // Default to oldest commit
          timeRange={timeRange}
        />
        <Divider orientation="vertical" flexItem>
          &mdash;Diff→
        </Divider>
        <BranchAndCommitPicker
          queryName={"oss_ci_benchmark_branches"}
          queryParams={queryParams}
          branch={rBranch}
          setBranch={setRBranch}
          commit={rCommit}
          setCommit={setRCommit}
          titlePrefix={"New"}
          fallbackIndex={0} // Default to the latest commit
          timeRange={timeRange}
        />
      </Stack>
      <LLMsReport
        queryParams={queryParams}
        startTime={props.startTime}
        stopTime={props.stopTime}
        granularity={props.granularity}
        repoName={props.repoName}
        benchmarkName={props.benchmarkName}
        modelName={props.modelName}
        backendName={props.backendName}
        modeName={props.modeName}
        dtypeName={props.dtypeName}
        deviceName={props.deviceName}
        archName={props.archName}
        metricNames={metricNames}
        lBranchAndCommit={{ branch: lBranch, commit: lCommit }}
        rBranchAndCommit={{ branch: rBranch, commit: rCommit }}
      />
    </div>
  );
}
