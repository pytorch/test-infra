import { Box } from "@mui/material";
import {
  DataGrid,
  GridRenderCellParams,
  GridTreeNodeWithRender,
} from "@mui/x-data-grid";
import LoadingPage from "components/common/LoadingPage";
import { durationDisplay } from "components/common/TimeUtils";
import { fetcher, useClickHouseAPIImmutable } from "lib/GeneralUtils";
import { JobData } from "lib/types";
import _ from "lodash";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { genMessage, isPending } from "./TestInfo";

function convertInfoToMap(info: any) {
  if (!info) {
    return undefined;
  }

  const infoMap = new Map();
  for (const build of Object.keys(info)) {
    for (const config of Object.keys(info[build])) {
      for (const file of Object.keys(info[build][config])) {
        const key = `${build}-${config}-${file}`;
        if (!infoMap.has(key)) {
          infoMap.set(key, {
            id: key,
            job: build,
            config: config,
            file: file,
            tests: 0,
            time: 0,
          });
        }
        infoMap.get(key).tests += info[build][config][file].count || 0;
        infoMap.get(key).time += info[build][config][file].time || 0;
      }
    }
  }
  return infoMap;
}

export function TestFileCountsInfo({
  headMap,
  baseMap,
  // This gets reused for the PR file report, but the PR file report has less
  // info, this parameter is used to control whether we have the large info or
  // the small info
  small,
}: {
  headMap: Map<string, any> | undefined;
  baseMap: Map<string, any> | undefined;
  small: boolean;
}) {
  const [visibleRows, setVisibleRows] = useState({});

  function calculateTotals() {
    const totals = {
      id: "totals",
      workflow: "Total",
      job: "Total",
      errors: 0,
      failures: 0,
      skipped: 0,
      successes: 0,
      tests: 0,
      time: 0,
      cost: 0,
      costChange: 0,
      timeChange: 0,
      errorsChange: 0,
      failuresChange: 0,
      skippedChange: 0,
      successesChange: 0,
      testsChange: 0,
    };
    for (const value of headMap?.values() || []) {
      if (!small) {
        totals.successesChange += value.successesChange || 0;
        totals.skippedChange += value.skippedChange || 0;
        totals.errorsChange += value.errorsChange || 0;
        totals.failuresChange += value.failuresChange || 0;
        totals.errors += value.errors || 0;
        totals.failures += value.failures || 0;
        totals.skipped += value.skipped || 0;
        totals.successes += value.successes || 0;
        totals.costChange += value.costChange || 0;
        totals.cost += value.cost || 0;
      }
      totals.timeChange += value.timeChange || 0;
      totals.testsChange += value.testsChange || 0;
      totals.tests += value.tests || 0;
      totals.time += value.time || 0;
    }
    return totals;
  }

  if (!headMap) {
    return <LoadingPage />;
  }
  if (baseMap) {
    for (const [key, value] of baseMap.entries()) {
      if (!headMap.has(key)) {
        headMap.set(key, {
          workflow: value.workflow,
          job: value.job,
          config: value.config,
          runner: value.runner,
          runnerCost: value.runnerCost,
          id: key,
        });
      }
      const headValue = headMap.get(key)!;
      headValue.timeChange = (headValue.time || 0) - value.time;
      headValue.costChange = (headValue.cost || 0) - value.cost;
      headValue.errorsChange = (headValue.errors || 0) - value.errors;
      headValue.failuresChange = (headValue.failures || 0) - value.failures;
      headValue.skippedChange = (headValue.skipped || 0) - value.skipped;
      headValue.successesChange = (headValue.successes || 0) - value.successes;
      headValue.testsChange = (headValue.tests || 0) - value.tests;
    }
    for (const [key, value] of headMap.entries()) {
      if (!baseMap.has(key)) {
        value.timeChange = value.time || 0;
        value.costChange = value.cost || 0;
        value.errorsChange = value.errors || 0;
        value.failuresChange = value.failures || 0;
        value.skippedChange = value.skipped || 0;
        value.successesChange = value.successes || 0;
        value.testsChange = value.tests || 0;
      }
    }
  }

  const columns: any[] = [];
  if (!small) {
    columns.push({
      field: "workflow",
      headerName: "Workflow",
      flex: 2,
    });
  }
  columns.push(
    ...[
      {
        field: "job",
        headerName: "Job",
        flex: 4,
      },
      {
        field: "config",
        headerName: "Config",
        flex: 2,
      },
    ]
  );
  if (small) {
    columns.push({
      field: "file",
      headerName: "file",
      flex: 2,
    });
  }
  if (!small) {
    columns.push({
      field: "runner",
      headerName: "Runner",
      flex: 2,
    });
  }

  function renderTimeCell(
    params: GridRenderCellParams<any, any, any, GridTreeNodeWithRender>
  ) {
    if (isNaN(params.value)) {
      return "";
    }
    return durationDisplay(parseFloat(params.value));
  }

  columns.push(
    ...[
      {
        field: "tests",
        headerName: "Tests",
        type: "number",
        flex: 2,
      },
      {
        field: "testsChange",
        headerName: "+/-",
        type: "number",
        flex: 1,
        cellClassName: "change",
      },
      {
        field: "time",
        headerName: "Time",
        type: "number",
        flex: 2,
        renderCell: renderTimeCell,
      },
      {
        field: "timeChange",
        headerName: "+/-",
        type: "number",
        flex: 1,
        renderCell: renderTimeCell,
        cellClassName: "change",
      },
    ]
  );
  if (!small) {
    columns.push(
      ...[
        {
          field: "cost",
          headerName: "Cost ($)",
          type: "number",
          flex: 2,
        },
        {
          field: "costChange",
          headerName: "+/-",
          type: "number",
          flex: 1,
          cellClassName: "change",
        },
        {
          field: "successes",
          headerName: "Successes",
          type: "number",
          flex: 2,
        },
        {
          field: "successesChange",
          headerName: "+/-",
          type: "number",
          flex: 1,
          cellClassName: "change",
        },
        {
          field: "skipped",
          headerName: "Skipped",
          type: "number",
          flex: 2,
        },
        {
          field: "skippedChange",
          headerName: "+/-",
          type: "number",
          flex: 1,
          cellClassName: "change",
        },
        {
          field: "errors",
          headerName: "Errors",
          type: "number",
          flex: 2,
        },
        {
          field: "errorsChange",
          headerName: "+/-",
          type: "number",
          flex: 1,
          cellClassName: "change",
        },
        {
          field: "failures",
          headerName: "Failures",
          type: "number",
          flex: 2,
        },
        {
          field: "failuresChange",
          headerName: "+/-",
          type: "number",
          flex: 1,
          cellClassName: "change",
        },
      ]
    );
  }

  const styling = {
    // Visual difference for rows that show diffs/changes
    "& .change": {
      backgroundColor: "rgba(213, 213, 213, 0.25)",
    },
    "& .total-row": {
      fontWeight: "bold",
      backgroundColor: "rgba(213, 213, 213, 0.25)",
    },
  };

  return (
    <>
      {/* Not great since the tables don't share state so if you adjust the
      headings for one, it won't adjust the other, but it works for now */}
      <Box style={{ flexDirection: "column" }}>
        <DataGrid
          density="compact"
          rows={[calculateTotals()]}
          sx={styling}
          columns={columns}
          getRowClassName={(params) => {
            if (params.row.id === "totals") {
              return "total-row";
            }
            return "";
          }}
          hideFooter
        />
        <DataGrid
          density="compact"
          rows={[...headMap.values()]}
          sx={styling}
          columns={columns}
          onStateChange={(model) => {
            if (!_.isEqual(model.visibleRowsLookup, visibleRows)) {
              setVisibleRows(model.visibleRowsLookup);
            }
          }}
        />
      </Box>
    </>
  );
}

function ComparisonStatus({
  comparisonSha,
  comparisonId,
  comparisonIdError,
  comparisonInfo,
  comparisonError,
}: {
  comparisonSha: string | undefined;
  comparisonId: any | undefined;
  comparisonIdError: any | undefined;
  comparisonInfo: any | undefined;
  comparisonError: any | undefined;
}) {
  if (!comparisonSha) {
    return <></>;
  } else if (comparisonIdError) {
    return (
      <div>
        Error retrieving corresponding workflow id {`${comparisonIdError}`}
      </div>
    );
  } else if (!comparisonId) {
    return <div>Loading...</div>;
  } else if (comparisonId.length == 0) {
    return <div>No corresponding workflow found</div>;
  } else if (comparisonError) {
    return <div>Error retrieving comparison data {`${comparisonError}`}</div>;
  } else if (!comparisonInfo) {
    return <div>Loading...</div>;
  }
  return <></>;
}

export function TestCountsInfo({
  workflowId,
  jobs,
  runAttempt,
}: {
  workflowId: string;
  jobs: JobData[];
  runAttempt: string;
}) {
  const shouldShow = jobs.some((job) => job.name!.includes("/ test "));
  const { data: info, error } = useSWR(
    shouldShow
      ? `https://ossci-raw-job-status.s3.amazonaws.com/additional_info/invoking_file_summary/${workflowId}/${runAttempt}`
      : null,
    fetcher
  );

  const [comparisonSha, setComparisonSha] = useState<string>();
  const { data: mergeBase } = useClickHouseAPIImmutable(
    "merge_bases",
    {
      repo: "pytorch/pytorch",
      shas: jobs.length > 0 ? [jobs[0].sha] : [],
    },
    jobs.length > 0 && jobs[0]?.sha !== undefined
  );

  useEffect(() => {
    if (comparisonSha === undefined && mergeBase) {
      setComparisonSha(mergeBase[0]?.merge_base);
    }
  }, [mergeBase, comparisonSha]);

  const { data: comparisonId, error: comparisonIdError } = useSWR(
    comparisonSha
      ? `/api/corresponding_workflow_id?sha=${comparisonSha}&workflowId=${workflowId}`
      : null,
    fetcher
  );
  const { data: comparisonInfo, error: comparisonInfoError } = useSWR(
    comparisonSha && comparisonId && comparisonId[0]
      ? `https://ossci-raw-job-status.s3.amazonaws.com/additional_info/invoking_file_summary/${comparisonId[0].id}/${runAttempt}`
      : null,
    fetcher
  );

  if (!shouldShow) {
    return <div>Workflow is still pending or there are no test jobs</div>;
  }

  const infoString = "No tests were run or there was trouble parsing data";
  if (error) {
    if (isPending(jobs)) {
      return (
        <div>
          {genMessage({
            infoString: infoString,
            pending: true,
            error: error,
          })}
        </div>
      );
    }
    return <div>Error retrieving data {`${error}`}</div>;
  }

  if (!info) {
    return <div>Loading...</div>;
  }

  if (Object.keys(info).length == 0) {
    if (isPending(jobs)) {
      return (
        <div>
          {genMessage({
            infoString: infoString,
            pending: true,
          })}
        </div>
      );
    }
    return <div>{infoString}</div>;
  }

  return (
    <div>
      <div style={{ fontSize: "1.17em", fontWeight: "bold", padding: "1em 0" }}>
        Test Times and Counts
      </div>
      <div>
        This shows the total number of tests and total time taken to run them.
        Click on the columns names to sort the table by that column. The finest
        granularity supported is the file level. Expand the build environment
        names and test configs to see the individual test files. You can also
        enter a sha below to compare the counts and times with the other sha.
        The Δ is current sha - comparison sha.
      </div>
      {isPending(jobs) && (
        <div>Workflow is still pending. Data may be incomplete.</div>
      )}
      <div style={{ padding: "1em 0" }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            // @ts-ignore
            setComparisonSha(e.target[0].value);
          }}
        >
          <input
            type="text"
            placeholder="Enter a sha to compare with"
            size={50}
            defaultValue={comparisonSha || ""}
          />
          <button type="submit">Submit</button>
        </form>
        <ComparisonStatus
          comparisonId={comparisonId}
          comparisonIdError={comparisonIdError}
          comparisonInfo={comparisonInfo}
          comparisonSha={comparisonSha}
          comparisonError={comparisonInfoError}
        />
      </div>
      <Box height="500px" sx={{ overflow: "auto" }}>
        <TestFileCountsInfo
          headMap={convertInfoToMap(info)}
          baseMap={convertInfoToMap(comparisonInfo)}
          small={true}
        />
      </Box>
    </div>
  );
}
