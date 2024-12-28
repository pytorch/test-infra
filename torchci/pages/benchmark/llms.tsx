import { Divider, Stack, Typography } from "@mui/material";
import { BranchAndCommitPicker } from "components/benchmark/BranchAndCommitPicker";
import { CommitPanel } from "components/benchmark/CommitPanel";
import {
  DEFAULT_REPO_NAME,
  LAST_N_DAYS,
  MAIN_BRANCH,
} from "components/benchmark/common";
import {
  DEFAULT_BACKEND_NAME,
  DEFAULT_DEVICE_NAME,
  DEFAULT_DTYPE_NAME,
  DEFAULT_MODEL_NAME,
  EXCLUDED_METRICS,
  REPO_TO_BENCHMARKS,
} from "components/benchmark/llms/common";
import { GraphPanel } from "components/benchmark/llms/ModelGraphPanel";
import { SummaryPanel } from "components/benchmark/llms/SummaryPanel";
import { DTypePicker } from "components/benchmark/ModeAndDTypePicker";
import CopyLink from "components/CopyLink";
import GranularityPicker from "components/GranularityPicker";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { computeSpeedup, TORCHAO_BASELINE } from "lib/benchmark/aoUtils";
import { useBenchmark } from "lib/benchmark/llmUtils";
import { fetcher } from "lib/GeneralUtils";
import { BranchAndCommit } from "lib/types";
import _ from "lodash";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { TimeRangePicker } from "../metrics";

function Report({
  queryParams,
  startTime,
  stopTime,
  granularity,
  repoName,
  modelName,
  backendName,
  dtypeName,
  deviceName,
  metricNames,
  lBranchAndCommit,
  rBranchAndCommit,
}: {
  queryParams: { [key: string]: any };
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  granularity: Granularity;
  repoName: string;
  modelName: string;
  backendName: string;
  dtypeName: string;
  deviceName: string;
  metricNames: string[];
  lBranchAndCommit: BranchAndCommit;
  rBranchAndCommit: BranchAndCommit;
}) {
  const { data: lData, error: _lError } = useBenchmark(
    queryParams,
    lBranchAndCommit
  );
  const { data: rData, error: _rError } = useBenchmark(
    queryParams,
    rBranchAndCommit
  );

  if (
    lData === undefined ||
    lData.length === 0 ||
    rData === undefined ||
    rData.length === 0
  ) {
    return (
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"1rem"} fontStyle={"italic"}>
          Loading records for {modelName}...
        </Typography>
      </Stack>
    );
  }

  const lDataWithSpeedup = computeSpeedup(repoName, lData);
  const rDataWithSpeedup = computeSpeedup(repoName, rData);

  if (repoName === "pytorch/ao") {
    metricNames = ["speedup", ...metricNames];
  }

  return (
    <div>
      <CommitPanel
        repoName={repoName}
        lBranchAndCommit={{
          ...rBranchAndCommit,
          date:
            rDataWithSpeedup !== undefined && rDataWithSpeedup.length !== 0
              ? rDataWithSpeedup[0].granularity_bucket
              : undefined,
        }}
        rBranchAndCommit={{
          ...lBranchAndCommit,
          date:
            lDataWithSpeedup !== undefined && lDataWithSpeedup.length !== 0
              ? lDataWithSpeedup[0].granularity_bucket
              : undefined,
        }}
        workflowName={"inductor-micro-benchmark"}
      >
        <></>
      </CommitPanel>
      <GraphPanel
        queryParams={queryParams}
        granularity={granularity}
        repoName={repoName}
        modelName={modelName}
        backendName={backendName}
        dtypeName={dtypeName}
        deviceName={deviceName}
        metricNames={metricNames}
        lBranchAndCommit={lBranchAndCommit}
        rBranchAndCommit={rBranchAndCommit}
      />
      <SummaryPanel
        startTime={startTime}
        stopTime={stopTime}
        granularity={granularity}
        repoName={repoName}
        modelName={modelName}
        backendName={backendName}
        metricNames={metricNames}
        lPerfData={{
          ...lBranchAndCommit,
          data: lDataWithSpeedup,
        }}
        rPerfData={{
          ...rBranchAndCommit,
          data: rDataWithSpeedup,
        }}
      />
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
  const [lBranch, setLBranch] = useState<string>(MAIN_BRANCH);
  const [lCommit, setLCommit] = useState<string>("");
  const [rBranch, setRBranch] = useState<string>(MAIN_BRANCH);
  const [rCommit, setRCommit] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [repoName, setRepoName] = useState<string>(DEFAULT_REPO_NAME);
  const [modelName, setModelName] = useState<string>(DEFAULT_MODEL_NAME);
  const [backendName, setBackendName] = useState<string>(DEFAULT_BACKEND_NAME);
  const [dtypeName, setDTypeName] = useState<string>(DEFAULT_DTYPE_NAME);
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

    const repoName: string = (router.query.repoName as string) ?? undefined;
    if (repoName !== undefined) {
      setRepoName(repoName);
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

    const dtypeName: string = (router.query.dtypeName as string) ?? undefined;
    if (dtypeName !== undefined) {
      setDTypeName(dtypeName);
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

  const queryName = "oss_ci_benchmark_names";
  const queryParams = {
    deviceArch: deviceName === DEFAULT_DEVICE_NAME ? "" : deviceName,
    dtypes:
      dtypeName === DEFAULT_DTYPE_NAME
        ? []
        : repoName !== "pytorch/ao"
        ? [dtypeName]
        : [dtypeName, TORCHAO_BASELINE],
    excludedMetrics: EXCLUDED_METRICS,
    benchmarks: REPO_TO_BENCHMARKS[repoName],
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
    return <>Loading {REPO_TO_BENCHMARKS[repoName].join(", ")}...</>;
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
  const dtypeNames: string[] = _.compact([
    DEFAULT_DTYPE_NAME,
    ..._.filter(
      _.uniq(data.map((r: any) => r.dtype)) as string[],
      (r: string) => r !== TORCHAO_BASELINE
    ),
  ]);
  const metricNames: string[] = _.uniq(data.map((r: any) => r.metric));

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          {REPO_TO_BENCHMARKS[repoName]} dashboard
        </Typography>
        <CopyLink
          textToCopy={`${baseUrl}?startTime=${encodeURIComponent(
            startTime.toString()
          )}&stopTime=${encodeURIComponent(
            stopTime.toString()
          )}&granularity=${granularity}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}&repoName=${encodeURIComponent(
            repoName
          )}&modelName=${encodeURIComponent(
            modelName
          )}&backendName=${encodeURIComponent(
            backendName
          )}&dtypeName=${encodeURIComponent(
            dtypeName
          )}&deviceName=${encodeURIComponent(deviceName)}`}
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
        {dtypeNames.length > 1 && (
          <DTypePicker
            dtype={dtypeName}
            setDType={setDTypeName}
            dtypes={dtypeNames}
            label={"DType"}
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
          queryCollection={"benchmarks"}
          queryParams={queryParams}
          branch={lBranch}
          setBranch={setLBranch}
          commit={lCommit}
          setCommit={setLCommit}
          titlePrefix={"Base"}
          fallbackIndex={1} // Default to previous commit
          timeRange={timeRange}
          useClickHouse={true}
        />
        <Divider orientation="vertical" flexItem>
          &mdash;Diff→
        </Divider>
        <BranchAndCommitPicker
          queryName={"oss_ci_benchmark_branches"}
          queryCollection={"benchmarks"}
          queryParams={queryParams}
          branch={rBranch}
          setBranch={setRBranch}
          commit={rCommit}
          setCommit={setRCommit}
          titlePrefix={"New"}
          fallbackIndex={0} // Default to the latest commit
          timeRange={timeRange}
          useClickHouse={true}
        />
      </Stack>
      <Report
        queryParams={queryParams}
        startTime={startTime}
        stopTime={stopTime}
        granularity={granularity}
        repoName={repoName}
        modelName={modelName}
        backendName={backendName}
        dtypeName={dtypeName}
        deviceName={deviceName}
        metricNames={metricNames}
        lBranchAndCommit={{ branch: lBranch, commit: lCommit }}
        rBranchAndCommit={{ branch: rBranch, commit: rCommit }}
      />
    </div>
  );
}
