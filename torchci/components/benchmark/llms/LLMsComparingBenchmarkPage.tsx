import { Stack, Typography } from "@mui/material";
import {
  DEFAULT_REPO_NAME,
  LAST_N_DAYS,
  MAIN_BRANCH,
} from "components/benchmark/common";
import CopyLink from "components/common/CopyLink";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import _, { cloneDeep } from "lodash";
import { NextRouter, useRouter } from "next/router";
import { ParsedUrlQuery } from "querystring";
import { useEffect, useMemo, useReducer, useState } from "react";
import { propsReducer } from "./context/BenchmarkProps";

import LoadingPage from "components/common/LoadingPage";
import {
  DEFAULT_ARCH_NAME,
  DEFAULT_BACKEND_NAME,
  DEFAULT_DEVICE_NAME,
  DEFAULT_DTYPE_NAME,
  DEFAULT_MODE_NAME,
  DEFAULT_MODEL_NAME,
  DEFAULT_QPS_NAME,
  HELION_BENCHMARK_NAME,
  LLM_BENCHMARK_CONFIG_QUERY,
  LLM_BENCHMARK_DATA_QUERY,
  REPO_TO_BENCHMARKS,
} from "lib/benchmark/llms/common";
import { LLMsBenchmarkMode } from "lib/benchmark/llms/types/benchmarkMode";
import { DropdownGroupItemType } from "lib/benchmark/llms/types/dashboardPickerTypes";
import { LLMsBenchmarkProps } from "lib/benchmark/llms/types/dashboardProps";
import { getBenchmarkDropdownFeatures } from "lib/benchmark/llms/utils/dashboardPickerUtils";
import {
  getLLMsBenchmarkPropsQueryParameter,
  useBenchmarkDataForRepos,
} from "lib/benchmark/llms/utils/llmUtils";
import { LLMsDashboardPicker } from "./components/dashboardPicker/LLMsDashboardPicker";
import { LLMsTimeRangePicker } from "./components/dashboardPicker/LLMsTimeRangePicker";
import LLMsComparisonReport from "./components/report/LLMsComparisonReport";

export default function LLMsComparingBenchmarkPage() {
  const router = useRouter();
  const defaultStartTime = dayjs().subtract(LAST_N_DAYS, "day");
  const defaultStopTime = dayjs();

  const initialPropsState: LLMsBenchmarkProps = {
    repoName: DEFAULT_REPO_NAME,
    benchmarkName: "",
    mode: LLMsBenchmarkMode.RepoComparison,
    modelName: DEFAULT_MODEL_NAME,
    backendName: DEFAULT_BACKEND_NAME,
    modeName: DEFAULT_MODE_NAME,
    dtypeName: DEFAULT_DTYPE_NAME,
    deviceName: DEFAULT_DEVICE_NAME,
    archName: DEFAULT_ARCH_NAME,
    qps: DEFAULT_QPS_NAME,
    startTime: defaultStartTime,
    stopTime: defaultStopTime,
    timeRange: LAST_N_DAYS,
    granularity: "day",
    lCommit: "",
    rCommit: "",
    lBranch: MAIN_BRANCH,
    rBranch: MAIN_BRANCH,
    repos: [],
  };

  const [props, dispatch] = useReducer(propsReducer, initialPropsState);

  return (
    <MainPageForComparison
      props={props}
      dispatch={dispatch}
      defaultStartTime={defaultStartTime}
      defaultStopTime={defaultStopTime}
      router={router}
    />
  );
}

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
        {getComparisonBenchmarkName(props.repos)}
        {formLink(props, baseUrl)}
      </Stack>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <LLMsTimeRangePicker props={props} dispatch={dispatch} />
      </Stack>
      <Stack>{children}</Stack>
    </div>
  );
};

const MainPageForComparison = ({
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
  const [qpsOptions, setQpsOptions] = useState<string[]>([]);
  const [modelQpsMap, setModelQpsMap] = useState<Record<string, string[]>>({});
  const queryParams = useMemo(
    () => getLLMsBenchmarkPropsQueryParameter(props),
    [props]
  );

  const repoQueryParams = useMemo(
    () =>
      props.repos.map((repo) => {
        const repoSpecificProps = { ...props, repoName: repo, repos: [] };
        return getLLMsBenchmarkPropsQueryParameter(repoSpecificProps);
      }),
    [
      props.repos,
      props.benchmarkName,
      props.modelName,
      props.backendName,
      props.modeName,
      props.dtypeName,
      props.deviceName,
      props.archName,
      props.startTime,
      props.stopTime,
      props.granularity,
      props.lCommit,
      props.rCommit,
      props.lBranch,
      props.rBranch,
    ]
  );

  const { data: configResults } = useBenchmarkDataForRepos(
    LLM_BENCHMARK_CONFIG_QUERY,
    repoQueryParams
  );
  const allRepoData = configResults?.map((r: any) => r.data) || [];
  const allRepoErrors = configResults?.map((r: any) => r.error) || [];
  const isLoading = !configResults;

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

  // Data fetching handled by useBenchmarkDataForRepos

  const modelQpsQueryParams = useMemo(
    () =>
      props.repos.map((repo) => {
        const repoSpecificProps = {
          ...props,
          repoName: repo,
          repos: [],
          modelName: DEFAULT_MODEL_NAME,
          qps: DEFAULT_QPS_NAME,
        };
        return getLLMsBenchmarkPropsQueryParameter(repoSpecificProps);
      }),
    [
      props.repos,
      props.backendName,
      props.modeName,
      props.dtypeName,
      props.deviceName,
      props.archName,
      props.startTime,
      props.stopTime,
      props.benchmarkName,
      props.granularity,
      props.rBranch,
      props.rCommit,
    ]
  );

  const modelQpsParamsWithBranch = useMemo(
    () =>
      modelQpsQueryParams.map((qp) => ({
        ...qp,
        branches: props.rBranch ? [props.rBranch] : [],
        commits: props.rCommit ? [props.rCommit] : [],
      })),
    [modelQpsQueryParams, props.rBranch, props.rCommit]
  );

  const { data: modelQpsResults } = useBenchmarkDataForRepos(
    LLM_BENCHMARK_DATA_QUERY,
    modelQpsParamsWithBranch
  );

  useEffect(() => {
    if (!modelQpsResults) {
      return;
    }
    const map: Record<string, string[]> = {};
    modelQpsResults.forEach((r: any) => {
      const data = (r.data || []) as any[];
      const grouped = _.groupBy(data, (rec) => rec.model);
      Object.entries(grouped).forEach(([model, recs]) => {
        const qpsValues = _.uniq(
          recs
            .map((rec: any) => rec.extra?.request_rate)
            .filter(
              (v): v is string | number =>
                v !== undefined &&
                v !== null &&
                v !== "" &&
                (v === "inf" || !isNaN(Number(v)))
            )
            .map((v) => (v === "inf" ? "inf" : String(Number(v))))
        );
        map[model] = _.uniq([...(map[model] || []), ...qpsValues]);
      });
    });
    Object.keys(map).forEach((m) =>
      map[m].sort(
        (a, b) =>
          (a === "inf" ? Infinity : Number(a)) -
          (b === "inf" ? Infinity : Number(b))
      )
    );
    setModelQpsMap(map);
  }, [modelQpsResults]);

  useEffect(() => {
    if (props.modelName === DEFAULT_MODEL_NAME) {
      setQpsOptions([]);
      dispatch({ type: "UPDATE_FIELD", field: "qps", value: DEFAULT_QPS_NAME });
      return;
    }
    const shared = modelQpsMap[props.modelName] || [];
    setQpsOptions([DEFAULT_QPS_NAME, ...shared]);
    if (!shared.includes(props.qps)) {
      dispatch({
        type: "UPDATE_FIELD",
        field: "qps",
        value: DEFAULT_QPS_NAME,
      });
    }
  }, [props.modelName, modelQpsMap]);

  const hasError = allRepoErrors.some((error) => error);
  if (hasError) {
    const errorRepos = props.repos.filter((_, index) => allRepoErrors[index]);
    return (
      <PrefetchRender props={props} dispatch={dispatch} baseUrl={baseUrl}>
        <>
          Error loading data for repositories: {errorRepos.join(", ")}, please
          select different time range, if this happens again, please reach out
          to the pytorch team.
        </>
      </PrefetchRender>
    );
  }

  const hasAllData = allRepoData.every((data) => data !== undefined);

  if (!hasAllData || isLoading) {
    return (
      <div>
        <PrefetchRender props={props} dispatch={dispatch} baseUrl={baseUrl}>
          <>
            Loading comparison data for repositories: {props.repos.join(", ")},
            please wait a moment...
          </>
        </PrefetchRender>
        <div>
          <LoadingPage />
        </div>
      </div>
    );
  }

  const hasEmptyData = allRepoData.some((data) => data.length === 0);
  if (hasEmptyData) {
    const emptyRepos = props.repos.filter(
      (_, index) => allRepoData[index]?.length === 0
    );
    return (
      <PrefetchRender props={props} dispatch={dispatch} baseUrl={baseUrl}>
        <>
          Found no records for repositories: {emptyRepos.join(", ")}, please
          select different time range
        </>
      </PrefetchRender>
    );
  }

  let combinedData = allRepoData.flatMap((repoData, index) => {
    const repo = props.repos[index];
    return repoData.map((dataItem: any) => ({
      ...dataItem,
      sourceRepo: repo,
    }));
  });

  const dropdownListsPerRepo = allRepoData.map((repoData, idx) =>
    getBenchmarkDropdownFeatures(repoData, props.repos[idx])
  );

  const sharedTypes = _.intersection(
    ...dropdownListsPerRepo.map((list) => list.map((item) => item.type))
  );

  const dropdownMapList = sharedTypes.map((type) => {
    const firstRepoItem = dropdownListsPerRepo[0].find((i) => i.type === type);
    const defaultOption = firstRepoItem?.options[0] || "";
    const optionsLists = dropdownListsPerRepo.map((list) => {
      const item = list.find((i) => i.type === type);
      return item ? item.options.slice(1) : [];
    });
    const sharedOptions = _.intersection(...optionsLists);
    const labelName = firstRepoItem?.labelName || "";
    return {
      type,
      labelName,
      options: [defaultOption, ...sharedOptions],
    };
  });

  if (qpsOptions.length > 1) {
    dropdownMapList.push({
      type: DropdownGroupItemType.Qps,
      labelName: "QPS",
      options: qpsOptions,
    });
  }

  if (props.modelName === DEFAULT_MODEL_NAME) {
    const modelDropdown = dropdownMapList.find(
      (d) => d.type === DropdownGroupItemType.ModelName
    );
    if (modelDropdown) {
      const sharedModels = modelDropdown.options.slice(1);
      combinedData = combinedData.filter((d: any) =>
        sharedModels.includes(d.model)
      );
    }
  }

  const metricNames = getMetricNames(combinedData);
  // Default to latest for Helion Benchmark, otherwise default to oldest commit
  const lcommitFallbackIdx =
    props.benchmarkName === HELION_BENCHMARK_NAME ? 0 : -1;
  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        {getComparisonBenchmarkName(props.repos)}
        {formLink(props, baseUrl)}
      </Stack>
      <LLMsDashboardPicker
        options={dropdownMapList}
        props={props}
        dispatch={dispatch}
        queryParams={queryParams}
        lcommitFallbackIdx={lcommitFallbackIdx}
      />
      <LLMsComparisonReport
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

  const repos = urlQuery.repos;
  if (repos !== undefined) {
    if (Array.isArray(repos)) {
      newProps.repos = repos as string[];
    } else if (typeof repos === "string") {
      newProps.repos = repos.split(",").map((repo) => repo.trim());
    }
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

  const archName: string = (urlQuery.archName as string) ?? undefined;
  if (archName !== undefined) {
    newProps.archName = archName;
  }

  const qps: string = (urlQuery.qps as string) ?? undefined;
  if (qps !== undefined) {
    newProps.qps = qps;
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

function getComparisonBenchmarkName(repos: string[]) {
  // Generate dynamic title for comparison mode using benchmark names
  const benchmarkNames = repos.map((repo) => {
    const repoKey = repo.trim();
    if (REPO_TO_BENCHMARKS[repoKey] && REPO_TO_BENCHMARKS[repoKey].length > 0) {
      return REPO_TO_BENCHMARKS[repoKey][0];
    }
    // Fallback to repository name if no mapping found
    const parts = repo.split("/");
    return parts[parts.length - 1];
  });

  const title =
    benchmarkNames.length === 2
      ? `${benchmarkNames[1]} vs ${benchmarkNames[0]} Comparison Dashboard`
      : `Multi-Repository Comparison Dashboard (${benchmarkNames.join(", ")})`;

  return (
    <Typography fontSize={"2rem"} fontWeight={"bold"}>
      {title}
    </Typography>
  );
}

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
      )}&archName=${encodeURIComponent(
        props.archName
      )}&repos=${encodeURIComponent(
        props.repos.join(",")
      )}&qps=${encodeURIComponent(props.qps)}`}
    />
  );
};
