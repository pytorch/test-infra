import dayjs from "dayjs";
import _ from "lodash";
import useSWR from "swr";
import { fetcher } from "lib/GeneralUtils";
import { RocksetParam } from "lib/rockset";
import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import CopyLink from "components/CopyLink";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import {
  Skeleton,
  Stack,
  Typography,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  SelectChangeEvent,
  Divider,
} from "@mui/material";
import { TimeRangePicker } from "../metrics";
import GranularityPicker from "components/GranularityPicker";
import { BranchAndCommitPicker } from "components/benchmark/BranchAndCommitPicker";
import { MAIN_BRANCH, LAST_N_DAYS } from "components/benchmark/common";
import {
  QUANTIZATIONS,
  DEFAULT_QUANTIZATION,
  BENCHMARKS,
  DEFAULT_MODEL_NAME,
} from "components/benchmark/llms/common";
import { DTypePicker } from "components/benchmark/ModeAndDTypePicker";
import { CommitPanel } from "components/benchmark/CommitPanel";
import { BranchAndCommit } from "lib/types";

function queryBenchmark(
  queryParams: RocksetParam[],
  modelName: string,
  branchAndCommit: BranchAndCommit
) {
  const queryCollection = "benchmarks";
  const queryName = "oss_ci_benchmark_llms";

  const queryParamsWithBranchAndCommit: RocksetParam[] = [
    {
      name: "branches",
      type: "string",
      value: branchAndCommit.branch,
    },
    {
      name: "commits",
      type: "string",
      value: branchAndCommit.commit,
    },
    {
      name: "names",
      type: "string",
      value: modelName === DEFAULT_MODEL_NAME ? "" : modelName,
    },
    ...queryParams,
  ];
  const lUrl = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithBranchAndCommit)
  )}`;

  return useSWR(lUrl, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });
}

function Report({
  queryParams,
  startTime,
  stopTime,
  granularity,
  quantization,
  modelName,
  lBranchAndCommit,
  rBranchAndCommit,
}: {
  queryParams: RocksetParam[];
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  granularity: Granularity;
  quantization: string;
  modelName: string;
  lBranchAndCommit: BranchAndCommit;
  rBranchAndCommit: BranchAndCommit;
}) {
  const { data: lData, error: lError } = queryBenchmark(
    queryParams,
    modelName,
    lBranchAndCommit
  );
  const { data: rData, error: rError } = queryBenchmark(
    queryParams,
    modelName,
    rBranchAndCommit
  );

  if (
    lData === undefined ||
    lData.length === 0 ||
    rData === undefined ||
    rData.length === 0
  ) {
    return (
      <>
        We found no data for {modelName} quantized in {quantization}.
      </>
    );
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
        workflowName={"inductor-micro-benchmark"}
      >
        <></>
      </CommitPanel>
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
  const [quantization, setQuantization] =
    useState<string>(DEFAULT_QUANTIZATION);
  const [granularity, setGranularity] = useState<Granularity>("hour");
  const [lBranch, setLBranch] = useState<string>(MAIN_BRANCH);
  const [lCommit, setLCommit] = useState<string>("");
  const [rBranch, setRBranch] = useState<string>(MAIN_BRANCH);
  const [rCommit, setRCommit] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [modelName, setModelName] = useState<string>(DEFAULT_MODEL_NAME);

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

    const quantization: string =
      (router.query.quantization as string) ?? undefined;
    if (quantization !== undefined) {
      setQuantization(quantization);
    }

    const modelName: string = (router.query.modelName as string) ?? undefined;
    if (modelName !== undefined) {
      setModelName(modelName);
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

  const queryCollection = "benchmarks";
  const queryName = "oss_ci_benchmark_names";
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
      name: "quantization",
      type: "string",
      value: quantization,
    },
    {
      name: "filenames",
      type: "string",
      value: BENCHMARKS.join(","),
    },
  ];

  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;
  const { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (data === undefined || data.length === 0) {
    return <>We found no data for {BENCHMARKS.join(", ")}.</>;
  }
  const modelNames: string[] = _.uniq(data.map((r: any) => r.name));
  modelNames.push(DEFAULT_MODEL_NAME);

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          LLMs Benchmark DashBoard
        </Typography>
        <CopyLink
          textToCopy={`${baseUrl}?startTime=${encodeURIComponent(
            startTime.toString()
          )}&stopTime=${encodeURIComponent(
            stopTime.toString()
          )}&granularity=${granularity}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}`}
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
          dtype={quantization}
          setDType={setQuantization}
          dtypes={QUANTIZATIONS}
          label={"Quantization"}
        />
        <DTypePicker
          dtype={modelName}
          setDType={setModelName}
          dtypes={modelNames}
          label={"Model"}
        />
        <BranchAndCommitPicker
          queryName={"oss_ci_benchmark_branches"}
          queryCollection={"benchmarks"}
          queryParams={queryParams}
          branch={rBranch}
          setBranch={setRBranch}
          commit={rCommit}
          setCommit={setRCommit}
          titlePrefix={"Base"}
          fallbackIndex={-1} // Default to the next to latest in the window
          timeRange={timeRange}
        />
        <Divider orientation="vertical" flexItem>
          &mdash;Diff→
        </Divider>
        <BranchAndCommitPicker
          queryName={"oss_ci_benchmark_branches"}
          queryCollection={"benchmarks"}
          queryParams={queryParams}
          branch={lBranch}
          setBranch={setLBranch}
          commit={lCommit}
          setCommit={setLCommit}
          titlePrefix={"New"}
          fallbackIndex={0} // Default to the latest commit
          timeRange={timeRange}
        />
      </Stack>

      <Report
        queryParams={queryParams}
        startTime={startTime}
        stopTime={stopTime}
        granularity={granularity}
        quantization={quantization}
        modelName={modelName}
        lBranchAndCommit={{ branch: lBranch, commit: lCommit }}
        rBranchAndCommit={{ branch: rBranch, commit: rCommit }}
      />
    </div>
  );
}
