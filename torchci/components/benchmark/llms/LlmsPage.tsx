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
import _ from "lodash";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { TimeRangePicker } from "../../../pages/metrics";
import LLMsReport from "./components/LLMsReport";

/**
 * @returns Main page for the LLMs dashboard
 * the page is routed in pagesM/bencmark/llms.tsx
 */
export default function LlmsPage() {
  const router = useRouter();

  const defaultStartTime = dayjs().subtract(LAST_N_DAYS, "day");
  const [startTime, setStartTime] = useState(defaultStartTime);
  const defaultStopTime = dayjs();
  const [stopTime, setStopTime] = useState(defaultStopTime);
  const [timeRange, setTimeRange] = useState<number>(LAST_N_DAYS);
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [lBranch, setLBranch] = useState<string>(MAIN_BRANCH);
  const [lCommit, setLCommit] = useState<string>("");
  const [rBranch, setRBranch] = useState<string>(MAIN_BRANCH);
  const [rCommit, setRCommit] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [repoName, setRepoName] = useState<string>(DEFAULT_REPO_NAME);
  const [benchmarkName, setBenchmarkName] = useState<string>("");
  const [modelName, setModelName] = useState<string>(DEFAULT_MODEL_NAME);
  const [backendName, setBackendName] = useState<string>(DEFAULT_BACKEND_NAME);
  const [modeName, setModeName] = useState<string>(DEFAULT_MODE_NAME);
  const [dtypeName, setDTypeName] = useState<string>(DEFAULT_DTYPE_NAME);
  const [deviceName, setDeviceName] = useState<string>(DEFAULT_DEVICE_NAME);
  const [archName, setArchName] = useState<string>(DEFAULT_ARCH_NAME);

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

    const repoName: string = (router.query.repoName as string) ?? undefined;
    if (repoName !== undefined) {
      setRepoName(repoName);
    }

    const benchmarkName: string =
      (router.query.benchmarkName as string) ?? undefined;
    if (benchmarkName != undefined) {
      setBenchmarkName(benchmarkName);
    }

    const modelName: string = (router.query.modelName as string) ?? undefined;
    if (modelName !== undefined) {
      setModelName(modelName);
    }

    const backendName: string =
      (router.query.backendName as string) ?? undefined;
    if (backendName !== undefined) {
      setBackendName(backendName);
    }

    const modeName: string = (router.query.modeName as string) ?? undefined;
    if (modeName !== undefined) {
      setModeName(modeName);
    }

    const dtypeName: string = (router.query.dtypeName as string) ?? undefined;
    if (dtypeName !== undefined) {
      setDTypeName(dtypeName);
    }

    const deviceName: string = (router.query.deviceName as string) ?? undefined;
    if (deviceName !== undefined) {
      setDeviceName(deviceName);
    }

    // Set the default arch to Android for ExecuTorch as it has only 2 options Android and iOS
    const archName: string = (router.query.archName as string) ?? undefined;
    if (archName !== undefined) {
      setArchName(archName);
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

  const queryName = "oss_ci_benchmark_names";
  const queryParams = {
    arch: archName === DEFAULT_ARCH_NAME ? "" : archName,
    device: deviceName === DEFAULT_DEVICE_NAME ? "" : deviceName,
    mode: modeName === DEFAULT_MODE_NAME ? "" : modeName,
    dtypes:
      dtypeName === DEFAULT_DTYPE_NAME
        ? []
        : repoName !== "pytorch/ao"
        ? [dtypeName]
        : [dtypeName, TORCHAO_BASELINE],
    excludedMetrics: EXCLUDED_METRICS,
    benchmarks: benchmarkName ? [benchmarkName] : REPO_TO_BENCHMARKS[repoName],
    granularity: granularity,
    models: modelName === DEFAULT_MODEL_NAME ? [] : [modelName],
    backends: backendName === DEFAULT_BACKEND_NAME ? [] : [backendName],
    repo: repoName,
    startTime: dayjs(startTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: dayjs(stopTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
  };

  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (data === undefined || data.length === 0) {
    return (
      <div>
        <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
          <Typography fontSize={"2rem"} fontWeight={"bold"}>
            {benchmarkName ? benchmarkName : REPO_TO_BENCHMARKS[repoName]}{" "}
            dashboard
          </Typography>
          <CopyLink
            textToCopy={`${baseUrl}?startTime=${encodeURIComponent(
              startTime.toString()
            )}&stopTime=${encodeURIComponent(
              stopTime.toString()
            )}&granularity=${granularity}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}&repoName=${encodeURIComponent(
              repoName
            )}&benchmarkName=${encodeURIComponent(
              benchmarkName
            )}&modelName=${encodeURIComponent(
              modelName
            )}&backendName=${encodeURIComponent(
              backendName
            )}&modeName=${encodeURIComponent(
              modeName
            )}&dtypeName=${encodeURIComponent(
              dtypeName
            )}&deviceName=${encodeURIComponent(
              deviceName
            )}&archName=${encodeURIComponent(archName)}`}
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
        </Stack>
        <Stack>
          <>
            Found no records for{" "}
            {(benchmarkName
              ? [benchmarkName]
              : REPO_TO_BENCHMARKS[repoName]
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

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          {benchmarkName ? benchmarkName : REPO_TO_BENCHMARKS[repoName]}{" "}
          dashboard
        </Typography>
        <CopyLink
          textToCopy={`${baseUrl}?startTime=${encodeURIComponent(
            startTime.toString()
          )}&stopTime=${encodeURIComponent(
            stopTime.toString()
          )}&granularity=${granularity}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}&repoName=${encodeURIComponent(
            repoName
          )}&benchmarkName=${encodeURIComponent(
            benchmarkName
          )}&modelName=${encodeURIComponent(
            modelName
          )}&backendName=${encodeURIComponent(
            backendName
          )}&modeName=${encodeURIComponent(
            modeName
          )}&dtypeName=${encodeURIComponent(
            dtypeName
          )}&deviceName=${encodeURIComponent(
            deviceName
          )}&archName=${encodeURIComponent(archName)}`}
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
        <DTypePicker
          dtype={modelName}
          setDType={setModelName}
          dtypes={modelNames}
          label={"Model"}
        />
        {backendNames.length > 1 && (
          <DTypePicker
            dtype={backendName}
            setDType={setBackendName}
            dtypes={backendNames}
            label={"Backend"}
          />
        )}
        {modeNames.length > 1 && (
          <DTypePicker
            dtype={modeName}
            setDType={setModeName}
            dtypes={modeNames}
            label={"Mode"}
          />
        )}
        {dtypeNames.length > 1 && (
          <DTypePicker
            dtype={dtypeName}
            setDType={setDTypeName}
            dtypes={dtypeNames}
            label={"DType"}
          />
        )}
        {repoName === "pytorch/executorch" && (
          <DTypePicker
            dtype={archName}
            setDType={setArchName}
            dtypes={[DEFAULT_ARCH_NAME, ...ARCH_NAMES[repoName]]}
            label={"Platform"}
          />
        )}
        <DTypePicker
          dtype={deviceName}
          setDType={setDeviceName}
          dtypes={deviceNames}
          label={"Device"}
        />
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
        startTime={startTime}
        stopTime={stopTime}
        granularity={granularity}
        repoName={repoName}
        benchmarkName={benchmarkName}
        modelName={modelName}
        backendName={backendName}
        modeName={modeName}
        dtypeName={dtypeName}
        deviceName={deviceName}
        archName={archName}
        metricNames={metricNames}
        lBranchAndCommit={{ branch: lBranch, commit: lCommit }}
        rBranchAndCommit={{ branch: rBranch, commit: rCommit }}
      />
    </div>
  );
}
