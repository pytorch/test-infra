import { Alert, Typography } from "@mui/material";
import { Grid, Stack } from "@mui/system";
import { AutoComponentProps } from "components/benchmark_v3/configs/utils/autoRegistration";
import LoadingPage from "components/common/LoadingPage";
import {
  useBenchmarkCommittedContext,
  useBenchmarkTimeSeriesData,
} from "lib/benchmark/api_helper/fe/hooks";
import { useDashboardSelector } from "lib/benchmark/store/benchmark_dashboard_provider";
import BenchmarkRawDataTable from "../components/benchmarkTimeSeries/components/BenchmarkRawDataTable";

import { LOG_PREFIX } from "components/benchmark/common";
import { UIRenderConfig } from "components/benchmark_v3/configs/config_book_types";
import { useEffect, useState } from "react";
import { BenchmarkLogSidePanelWrapper } from "../../common/BenchmarkLogViewer/BenchmarkSidePanel";
import { RenderRawContent } from "../../common/RawContentDialog";
import BenchmarkTimeSeriesChartGroup from "../components/benchmarkTimeSeries/components/BenchmarkTimeSeriesChart/BenchmarkTimeSeriesChartGroup";
import { ComparisonTable } from "../components/benchmarkTimeSeries/components/BenchmarkTimeSeriesComparisonSection/BenchmarkTimeSeriesComparisonTable/ComparisonTable";

export function AutoBenchmarkTimeSeriesTable({ config }: AutoComponentProps) {
  const ctx = useBenchmarkCommittedContext();
  const ready =
    !!ctx &&
    !!ctx.committedTime?.start &&
    !!ctx.committedTime?.end &&
    !!ctx.committedLbranch &&
    !!ctx.committedRbranch &&
    ctx.requiredFilters.every((k: string) => !!ctx.committedFilters[k]);

  const dataBinding = ctx?.configHandler.dataBinding;
  const uiRenderConfig = config as UIRenderConfig;

  const branches = [
    ...new Set(
      [ctx.committedLbranch, ctx.committedRbranch].filter((b) => b.length > 0)
    ),
  ];

  // convert to the query params
  const params = dataBinding.toQueryParams({
    repo: ctx.repo,
    branches: branches,
    benchmarkName: ctx.benchmarkName,
    timeRange: ctx.committedTime,
    filters: ctx.committedFilters,
    maxSampling: ctx.committedMaxSampling,
  });

  const queryParams: any | null = ready ? params : null;
  // fetch the bechmark data
  const {
    data: resp,
    isLoading,
    error,
  } = useBenchmarkTimeSeriesData(ctx.benchmarkId, queryParams, ["table"]);

  const subrenders = ctx.config.raw.dataRender.subSectionRenders;
  const renderGroupId = useDashboardSelector((s) => s.renderGroupId);
  const update = useDashboardSelector((s) => s.update);

  const onPrimaryFieldSelect = (selected: any) => {
    if (!selected?.config?.navigation) {
      return;
    }
    const navigation = selected.config.navigation;
    const { type, value } = navigation;
    const groupInfo = selected?.groupInfo ?? {};
    switch (type) {
      case "subSectionRender":
        if (!subrenders) {
          return;
        }
        const subRender = subrenders[value];
        if (!subRender) {
          return;
        }
        if (renderGroupId === value) {
          return;
        }

        const fields = navigation?.applyFilterFields ?? [];
        let changed: Record<string, string> = {};

        if (fields.length === 0) {
          return;
        }

        for (const field of fields) {
          changed[field] = groupInfo[field];
        }

        update({
          renderGroupId: value,
          filters: {
            ...ctx.committedFilters,
            ...changed,
          },
        });
      default:
        return;
    }
  };

  if (isLoading) {
    return (
      <LoadingPage
        height={500}
        content="loading data for AutoBenchmarkTimeSeriesTable..."
      />
    );
  }

  if (error) {
    return (
      <Alert severity="error">
        (AutoBenchmarkTimeSeriesTable){error.message}
      </Alert>
    );
  }

  if (!resp?.data?.data) {
    return <div>no data</div>;
  }
  const data = resp?.data?.data;
  return (
    <Grid container sx={{ m: 1 }}>
      <Grid sx={{ p: 0.2 }} size={{ xs: 12 }}>
        <ComparisonTable
          data={data["table"]}
          config={uiRenderConfig.config}
          lWorkflowId={ctx.lcommit?.workflow_id ?? null}
          rWorkflowId={ctx.rcommit?.workflow_id ?? null}
          title={{
            text: uiRenderConfig?.title ?? "Comparison Table",
          }}
          onSelect={() => {}}
          onPrimaryFieldSelect={onPrimaryFieldSelect}
        />
      </Grid>
    </Grid>
  );
}

export function AutoBenchmarkPairwiseTable({ config }: AutoComponentProps) {
  const ctx = useBenchmarkCommittedContext();
  const [timedOut, setTimedOut] = useState(false);
  const isWorkflowsReady =
    !!ctx.lcommit?.workflow_id &&
    !!ctx.rcommit?.workflow_id &&
    ctx.lcommit.branch === ctx.committedLbranch &&
    ctx.rcommit.branch === ctx.committedRbranch;

  const ready =
    !!ctx &&
    !!ctx.committedTime?.start &&
    !!ctx.committedTime?.end &&
    !!ctx.committedLbranch &&
    !!ctx.committedRbranch &&
    isWorkflowsReady &&
    ctx.requiredFilters.every((k: string) => !!ctx.committedFilters[k]);

  useEffect(() => {
    if (!ready) {
      const id = setTimeout(() => {
        setTimedOut(true);
      }, 30000); // 30 seconds
      return () => clearTimeout(id);
    } else {
      setTimedOut(false);
    }
  }, [ready]);

  const dataBinding = ctx?.configHandler.dataBinding;
  const uiRenderConfig = config as UIRenderConfig;

  const branches = [
    ...new Set(
      [ctx.committedLbranch, ctx.committedRbranch].filter((b) => b.length > 0)
    ),
  ];
  const workflows =
    ctx.lcommit?.workflow_id && ctx.rcommit?.workflow_id
      ? [ctx.lcommit?.workflow_id, ctx.rcommit?.workflow_id]
      : [];

  // convert to the query params
  const params = dataBinding.toQueryParams({
    repo: ctx.repo,
    branches: branches,
    benchmarkName: ctx.benchmarkName,
    timeRange: ctx.committedTime,
    filters: ctx.committedFilters,
    maxSampling: ctx.committedMaxSampling,
    workflows,
  });

  const subrenders = ctx.config.raw.dataRender.subSectionRenders;
  const renderGroupId = useDashboardSelector((s) => s.renderGroupId);
  const update = useDashboardSelector((s) => s.update);

  // todo(elainewy): make this shared function
  const onPrimaryFieldSelect = (selected: any) => {
    if (!selected?.config?.navigation) {
      return;
    }
    const navigation = selected.config.navigation;
    const { type, value } = navigation;
    const groupInfo = selected?.groupInfo ?? {};
    switch (type) {
      case "subSectionRender":
        if (!subrenders) {
          return;
        }
        const subRender = subrenders[value];
        if (!subRender) {
          return;
        }
        if (renderGroupId === value) {
          return;
        }

        const fields = navigation?.applyFilterFields ?? [];
        let changed: Record<string, string> = {};

        if (fields.length === 0) {
          return;
        }

        for (const field of fields) {
          changed[field] = groupInfo[field];
        }

        update({
          renderGroupId: value,
          filters: {
            ...ctx.committedFilters,
            ...changed,
          },
        });
      default:
        return;
    }
  };

  const queryParams: any | null = ready ? params : null;
  // fetch the bechmark data
  const {
    data: resp,
    isLoading,
    error,
  } = useBenchmarkTimeSeriesData(ctx.benchmarkId, queryParams, ["table"]);

  if (!ready && !timedOut) {
    return (
      <LoadingPage height={500} content="Waiting for initialization...." />
    );
  }

  if (timedOut) {
    return <Alert severity="warning">[Timeout(30s)]unable to fetch data</Alert>;
  }

  if (error) {
    return (
      <Alert severity="error">
        (AutoBenchmarkTimeSeriesTable){error.message}
      </Alert>
    );
  }

  if (isLoading || !resp) {
    return (
      <LoadingPage
        height={500}
        content="loading data for AutoBenchmarkPairwiseTable..."
      />
    );
  }

  if (!resp?.data?.data) {
    return <div>no data</div>;
  }

  const data = resp?.data?.data;
  return (
    <Grid container sx={{ m: 1 }}>
      <Grid sx={{ p: 0.2 }} size={{ xs: 12 }}>
        <RenderRawContent data={data["table"]} />
        <ComparisonTable
          data={data["table"]}
          config={uiRenderConfig.config}
          lWorkflowId={ctx.lcommit?.workflow_id ?? null}
          rWorkflowId={ctx.rcommit?.workflow_id ?? null}
          title={{
            text: uiRenderConfig?.title ?? "Comparison Table",
          }}
          onSelect={() => {}}
          onPrimaryFieldSelect={onPrimaryFieldSelect}
        />
      </Grid>
    </Grid>
  );
}

export function AutoBenchmarkLogs({ config }: AutoComponentProps) {
  const ctx = useBenchmarkCommittedContext();

  const isWorkflowsReady =
    !!ctx.lcommit?.workflow_id &&
    !!ctx.rcommit?.workflow_id &&
    ctx.lcommit.branch === ctx.committedLbranch &&
    ctx.rcommit.branch === ctx.committedRbranch;

  const ready =
    !!ctx &&
    !!ctx.committedTime?.start &&
    !!ctx.committedTime?.end &&
    !!ctx.committedLbranch &&
    !!ctx.committedRbranch &&
    isWorkflowsReady &&
    ctx.requiredFilters.every((k: string) => !!ctx.committedFilters[k]);

  const dataBinding = ctx?.configHandler.dataBinding;

  const uiRenderConfig = config as UIRenderConfig;

  const branches = [
    ...new Set(
      [ctx.committedLbranch, ctx.committedRbranch].filter((b) => b.length > 0)
    ),
  ];
  const workflows =
    ctx.lcommit?.workflow_id && ctx.rcommit?.workflow_id
      ? [ctx.lcommit?.workflow_id, ctx.rcommit?.workflow_id]
      : [];

  // convert to the query params
  const params = dataBinding.toQueryParams({
    repo: ctx.repo,
    branches: branches,
    benchmarkName: ctx.benchmarkName,
    timeRange: ctx.committedTime,
    filters: ctx.committedFilters,
    maxSampling: ctx.committedMaxSampling,
    workflows,
  });

  const queryParams: any | null = ready ? params : null;
  // fetch the bechmark data
  const {
    data: resp,
    isLoading,
    error,
  } = useBenchmarkTimeSeriesData(ctx.benchmarkId, queryParams, ["table"]);

  if (!ready) {
    return (
      <LoadingPage height={100} content="Waiting for initialization...." />
    );
  }

  if (isLoading || !resp) {
    return (
      <LoadingPage
        height={500}
        content="loading data for AutoBenchmarkLogs..."
      />
    );
  }

  if (error) {
    return (
      <Alert severity="error">
        (AutoBenchmarkTimeSeriesTable){error.message}
      </Alert>
    );
  }

  if (!resp?.data?.data) {
    return <div>no data</div>;
  }

  const data = resp?.data?.data;
  const rows = (data["table"] as any[]) ?? [];
  const workflowJobMap = new Map<string, string[]>();

  const jobInfo = collectJobGroupInfoUniques(
    rows,
    uiRenderConfig.config?.logFields ?? []
  );

  for (const row of rows) {
    const wf = row.group_info?.workflow_id;
    const job = row.group_info?.job_id;
    if (!wf || !job) continue;
    if (!workflowJobMap.has(wf)) {
      workflowJobMap.set(wf, []);
    }
    const jobs = workflowJobMap.get(wf)!;
    if (!jobs.includes(job)) {
      jobs.push(job);
    }
  }

  return (
    <Stack sx={{ m: 1 }}>
      <Typography variant="h6">Logging: </Typography>
      <Typography
        variant="subtitle1"
        sx={{ color: "text.secondary", fontWeight: 400 }}
      >
        {" "}
        log details from selected workflow runs{" "}
      </Typography>
      <Stack flexDirection="row">
        {Array.from(workflowJobMap.entries()).map(([wf, jobs]) => {
          const urls = jobs.map((job: string) => ({
            url: `${LOG_PREFIX}/${job}`,
            info: jobInfo.get(job),
          }));
          const isl = ctx.lcommit?.workflow_id == wf;
          return (
            <Stack key={wf} flexDirection="row" alignItems="center">
              <Typography variant="body2" sx={{ padding: 1 }}>
                {isl ? "l" : "r"}workflow ({wf}):{" "}
              </Typography>
              <BenchmarkLogSidePanelWrapper
                urls={urls}
                buttonLabel={`logs (${urls.length})`}
              />
            </Stack>
          );
        })}
      </Stack>
    </Stack>
  );
}

export function AutoBenchmarkTimeSeriesChartGroup({
  config,
}: AutoComponentProps) {
  const ctx = useBenchmarkCommittedContext();
  const ready =
    !!ctx &&
    !!ctx.committedTime?.start &&
    !!ctx.committedTime?.end &&
    !!ctx.committedLbranch &&
    !!ctx.committedRbranch &&
    ctx.requiredFilters.every((k: string) => !!ctx.committedFilters[k]);

  const dataBinding = ctx?.configHandler.dataBinding;
  const uiRenderConfig = config as UIRenderConfig;

  const branches = [
    ...new Set(
      [ctx.committedLbranch, ctx.committedRbranch].filter((b) => b.length > 0)
    ),
  ];

  // convert to the query params
  const params = dataBinding.toQueryParams({
    repo: ctx.repo,
    branches: branches,
    benchmarkName: ctx.benchmarkName,
    timeRange: ctx.committedTime,
    filters: ctx.committedFilters,
    maxSampling: ctx.committedMaxSampling,
  });

  const queryParams: any | null = ready ? params : null;
  // fetch the bechmark data
  const {
    data: resp,
    isLoading,
    error,
  } = useBenchmarkTimeSeriesData(ctx.benchmarkId, queryParams, ["time_series"]);

  if (isLoading) {
    return (
      <LoadingPage
        height={500}
        content="loading data for AutoBenchmarkTimeSeriesChartGroup..."
      />
    );
  }

  if (error) {
    return (
      <Alert severity="error">
        (AutoBenchmarkTimeSeriesTable){error.message}
      </Alert>
    );
  }

  if (!resp?.data?.data) {
    return <div>no data</div>;
  }
  const data = resp?.data?.data;
  return (
    <Grid container sx={{ m: 1 }}>
      <Grid sx={{ p: 0.2 }} size={{ xs: 12 }}>
        <Typography variant="h6">
          {uiRenderConfig?.title?.toUpperCase()}
        </Typography>
        <BenchmarkTimeSeriesChartGroup
          data={data["time_series"]}
          chartGroup={uiRenderConfig.config}
          onSelect={(payload: any) => {}}
          lcommit={ctx.lcommit ?? undefined}
          rcommit={ctx.rcommit ?? undefined}
        />
      </Grid>
    </Grid>
  );
}

export function AutoBenchmarkRawDataTable({ config }: AutoComponentProps) {
  const ctx = useBenchmarkCommittedContext();
  const ready =
    !!ctx &&
    !!ctx.committedTime?.start &&
    !!ctx.committedTime?.end &&
    !!ctx.committedLbranch &&
    !!ctx.committedRbranch &&
    ctx.requiredFilters.every((k: string) => !!ctx.committedFilters[k]);

  const dataBinding = ctx?.configHandler.dataBinding;
  const uiRenderConfig = config as UIRenderConfig;

  const branches = [
    ...new Set(
      [ctx.committedLbranch, ctx.committedRbranch].filter((b) => b.length > 0)
    ),
  ];

  // convert to the query params
  const params = dataBinding.toQueryParams({
    repo: ctx.repo,
    branches: branches,
    benchmarkName: ctx.benchmarkName,
    timeRange: ctx.committedTime,
    filters: ctx.committedFilters,
    maxSampling: ctx.committedMaxSampling,
  });

  const queryParams: any | null = ready ? params : null;
  // fetch the bechmark data
  const {
    data: resp,
    isLoading,
    error,
  } = useBenchmarkTimeSeriesData(ctx.benchmarkId, queryParams, ["table"]);

  if (isLoading) {
    return (
      <LoadingPage
        height={500}
        content="loading data for AutoBenchmarkRawDataTable..."
      />
    );
  }

  if (error) {
    return (
      <Alert severity="error">(AutoBenchmarkRawDataTable){error.message}</Alert>
    );
  }

  if (!resp?.data?.data) {
    return <div>no data</div>;
  }
  const data = resp?.data?.data;

  return (
    <Grid container sx={{ m: 1 }}>
      <Grid sx={{ p: 0.2 }} size={{ xs: 12 }}>
        <BenchmarkRawDataTable
          data={data["table"]}
          config={uiRenderConfig.config}
          title={{
            text: uiRenderConfig?.title ?? "Raw Table",
            description: "list all the workflow run data within the time range",
          }}
        />
      </Grid>
    </Grid>
  );
}

export function collectJobGroupInfoUniques(
  rows: any[],
  fields: string[]
): Map<string, Record<string, string[]>> {
  const jobInfo = new Map<string, Record<string, string[]>>();

  for (const row of rows ?? []) {
    const gi = row.group_info;
    if (!gi || !gi.job_id) continue;

    const job = gi.job_id;
    if (!jobInfo.has(job)) jobInfo.set(job, {});
    const info = jobInfo.get(job)!;
    for (const f of fields) {
      const v = gi[f];
      if (v == null) continue;
      if (!info[f]) info[f] = [];
      if (!info[f].includes(v)) info[f].push(v);
    }
  }

  return jobInfo;
}
