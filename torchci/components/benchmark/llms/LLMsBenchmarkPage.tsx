import { Stack, Typography } from "@mui/material";
import {
  DEFAULT_REPO_NAME,
  LAST_N_DAYS,
  MAIN_BRANCH,
} from "components/benchmark/common";
import CopyLink from "components/CopyLink";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import _, { cloneDeep } from "lodash";
import { NextRouter, useRouter } from "next/router";
import { ParsedUrlQuery } from "querystring";
import { useEffect, useReducer, useState } from "react";
import { propsReducer } from "./context/BenchmarkProps";

import LoadingPage from "components/LoadingPage";
import {
  DEFAULT_ARCH_NAME,
  DEFAULT_BACKEND_NAME,
  DEFAULT_DEVICE_NAME,
  DEFAULT_DTYPE_NAME,
  DEFAULT_MODE_NAME,
  DEFAULT_MODEL_NAME,
  REPO_TO_BENCHMARKS,
} from "lib/benchmark/llms/common";
import { LLMsBenchmarkProps } from "lib/benchmark/llms/types/dashboardProps";
import { getBenchmarkDropdownFeatures } from "lib/benchmark/llms/utils/dashboardPickerUtils";
import {
  getLLMsBenchmarkPropsQueryParameter,
  useBenchmarkPropsData,
} from "lib/benchmark/llms/utils/llmUtils";
import { LLMsDashboardPicker } from "./components/dashboardPicker/LLMsDashboardPicker";
import { LLMsTimeRangePicker } from "./components/dashboardPicker/LLMsTimeRangePicker";
import LLMsReport from "./components/LLMsReport";

export default function LLMsBenchmarkPage() {
  const router = useRouter();

  // Set the default start and stop time to be the last N days when the page is loaded
  const defaultStartTime = dayjs().subtract(LAST_N_DAYS, "day");
  const defaultStopTime = dayjs();

  const initialPropsState: LLMsBenchmarkProps = {
    repoName: DEFAULT_REPO_NAME,
    benchmarkName: "",
    modelName: DEFAULT_MODEL_NAME,
    backendName: DEFAULT_BACKEND_NAME,
    modeName: DEFAULT_MODE_NAME,
    dtypeName: DEFAULT_DTYPE_NAME,
    deviceName: DEFAULT_DEVICE_NAME,
    archName: DEFAULT_ARCH_NAME,
    startTime: defaultStartTime,
    stopTime: defaultStopTime,
    timeRange: LAST_N_DAYS,
    granularity: "day",
    lCommit: "",
    rCommit: "",
    lBranch: MAIN_BRANCH,
    rBranch: MAIN_BRANCH,
  };

  const [props, dispatch] = useReducer(propsReducer, initialPropsState);

  // pass initial state in runtime for benchmark props
  return (
    <MainPage
      props={props}
      dispatch={dispatch}
      defaultStartTime={defaultStartTime}
      defaultStopTime={defaultStopTime}
      router={router}
    />
  );
}

// render the page before the data is loaded or when an error occured
const PrefetchRender = ({
  children,
  props,
  dispatch,
  baseUrl,
}: {
  children: any;
  props: LLMsBenchmarkProps;
  dispatch: React.Dispatch<any>;
  baseUrl: string;
}) => {
  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        {getBenchmarkName(props.benchmarkName, props.repoName)}
        {formLink(props, baseUrl)}
      </Stack>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <LLMsTimeRangePicker props={props} dispatch={dispatch} />
      </Stack>
      <Stack>{children}</Stack>
    </div>
  );
};

/**
 * @returns Main page for the LLMs dashboard
 * the page is routed in pagesM/bencmark/llms.tsx
 */
const MainPage = ({
  defaultStartTime,
  defaultStopTime,
  props,
  dispatch,
  router,
}: {
  defaultStartTime: dayjs.Dayjs;
  defaultStopTime: dayjs.Dayjs;
  router: NextRouter;
  props: LLMsBenchmarkProps;
  dispatch: React.Dispatch<any>;
}) => {
  const [baseUrl, setBaseUrl] = useState<string>("");
  useEffect(() => {
    const newProps = resetProps(
      router.query,
      props,
      defaultStartTime,
      defaultStopTime
    );
    dispatch({ type: "UPDATE_FIELDS", payload: newProps });
    setBaseUrl(
      `${window.location.protocol}//${
        window.location.host
      }${router.asPath.replace(/\?.+/, "")}`
    );
  }, [router.query]);
  const queryParams = getLLMsBenchmarkPropsQueryParameter(props);
  const { data, error, isLoading } = useBenchmarkPropsData(queryParams);

  // an error occured while fetching the benchmark props data
  // give user choice for time range picker
  if (error) {
    return (
      <PrefetchRender props={props} dispatch={dispatch} baseUrl={baseUrl}>
        <>
          Error loading data for{" "}
          {(props.benchmarkName
            ? [props.benchmarkName]
            : REPO_TO_BENCHMARKS[props.repoName]
          ).join(", ")}
          , please select different time range, if this happens again, please
          reach out to the pytorch team.
        </>
      </PrefetchRender>
    );
  }

  // the benchmark props data is stil loading
  if (!data && isLoading) {
    return (
      <div>
        <PrefetchRender props={props} dispatch={dispatch} baseUrl={baseUrl}>
          <>
            Loading data for{" "}
            {(props.benchmarkName
              ? [props.benchmarkName]
              : REPO_TO_BENCHMARKS[props.repoName]
            ).join(", ")}
            , please wait a min
          </>
        </PrefetchRender>
        <div>
          <LoadingPage />
        </div>
      </div>
    );
  }

  // no prop data found for the given time range
  if (data.length === 0) {
    return (
      <PrefetchRender props={props} dispatch={dispatch} baseUrl={baseUrl}>
        <>
          Found no records for{" "}
          {(props.benchmarkName
            ? [props.benchmarkName]
            : REPO_TO_BENCHMARKS[props.repoName]
          ).join(", ")}
          , please select different time range
        </>
      </PrefetchRender>
    );
  }

  const options = data;
  const dropdownMapList = getBenchmarkDropdownFeatures(options, props.repoName);
  const metricNames = getMetricNames(data);
  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        {getBenchmarkName(props.benchmarkName, props.repoName)}
        {formLink(props, baseUrl)}
      </Stack>
      <LLMsDashboardPicker
        options={dropdownMapList}
        props={props}
        dispatch={dispatch}
        queryParams={queryParams}
      />
      <LLMsReport
        props={props}
        metricNames={metricNames}
        benchmarkPropsQueryParams={queryParams}
      />
    </div>
  );
};

function getMetricNames(data: any) {
  const metricNames = _.uniq(data.map((r: any) => r.metric));
  return metricNames as string[];
}

function resetProps(
  urlQuery: ParsedUrlQuery,
  prevProps: any,
  defaultStartTime: dayjs.Dayjs,
  defaultStopTime: dayjs.Dayjs
) {
  const newProps = cloneDeep(prevProps);
  const startTime: string = (urlQuery.startTime as string) ?? undefined;

  if (startTime !== undefined) {
    newProps.startTime = dayjs(startTime);
    if (dayjs(startTime).valueOf() !== defaultStartTime.valueOf()) {
      newProps.timeRange = -1;
    }
  }
  const stopTime: string = (urlQuery.stopTime as string) ?? undefined;
  if (stopTime !== undefined) {
    newProps.stopTime = dayjs(stopTime);
    if (dayjs(stopTime).valueOf() !== defaultStopTime.valueOf()) {
      newProps.timeRange = -1;
    }
  }

  const granularity: Granularity =
    (urlQuery.granularity as Granularity) ?? undefined;
  if (granularity !== undefined) {
    newProps.granularity = granularity;
  }

  const repoName: string = (urlQuery.repoName as string) ?? undefined;
  if (repoName !== undefined && repoName) {
    newProps.repoName = repoName;
  }

  const benchmarkName: string = (urlQuery.benchmarkName as string) ?? undefined;
  if (benchmarkName != undefined) {
    newProps.benchmarkName = benchmarkName;
  }

  const modelName: string = (urlQuery.modelName as string) ?? undefined;
  if (modelName !== undefined) {
    newProps.modelName = modelName;
  }

  const backendName: string = (urlQuery.backendName as string) ?? undefined;
  if (backendName !== undefined) {
    newProps.backendName = backendName;
  }

  const modeName: string = (urlQuery.modeName as string) ?? undefined;
  if (modeName !== undefined) {
    newProps.modeName = modeName;
  }

  const dtypeName: string = (urlQuery.dtypeName as string) ?? undefined;
  if (dtypeName !== undefined) {
    newProps.dtypeName = dtypeName;
  }

  const deviceName: string = (urlQuery.deviceName as string) ?? undefined;
  if (deviceName !== undefined) {
    newProps.deviceName = deviceName;
  }

  // Set the default arch to Android for ExecuTorch as it has only 2 options Android and iOS
  const archName: string = (urlQuery.archName as string) ?? undefined;
  if (archName !== undefined) {
    newProps.archName = archName;
  }

  const lBranch: string = (urlQuery.lBranch as string) ?? undefined;
  if (lBranch !== undefined) {
    newProps.lBranch = lBranch;
  }

  const lCommit: string = (urlQuery.lCommit as string) ?? undefined;
  if (lCommit !== undefined) {
    newProps.lCommit = lCommit;
  }

  const rBranch: string = (urlQuery.rBranch as string) ?? undefined;
  if (rBranch !== undefined) {
    newProps.rBranch = rBranch;
  }

  const rCommit: string = (urlQuery.rCommit as string) ?? undefined;
  if (rCommit !== undefined) {
    newProps.rCommit = rCommit;
  }
  return newProps;
}

const getBenchmarkName = (benchmarkName: string | any, repoName: string) => {
  return (
    <Typography fontSize={"2rem"} fontWeight={"bold"}>
      {benchmarkName ? benchmarkName : REPO_TO_BENCHMARKS[repoName]} dashboard
    </Typography>
  );
};

const formLink = (props: LLMsBenchmarkProps, baseUrl: string) => {
  return (
    <CopyLink
      textToCopy={`${baseUrl}?startTime=${encodeURIComponent(
        props.startTime.toString()
      )}&stopTime=${encodeURIComponent(
        props.stopTime.toString()
      )}&granularity=${props.granularity}&lBranch=${props.lBranch}&lCommit=${
        props.lCommit
      }&rBranch=${props.rBranch}&rCommit=${
        props.rCommit
      }&repoName=${encodeURIComponent(
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
  );
};
