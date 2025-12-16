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
  for (const row of info) {
    const key = `${row.job_name}-${row.file}`;
    infoMap.set(key, {
      workflow: row.workflow_name,
      job: row.job_name,
      file: row.file,
      successes: row.success,
      failures: row.failure,
      skipped: row.skipped,
      time: row.time || 0,
      id: key,
    });
  }
  return infoMap;
}

function TestFileCountsInfo({
  headMap,
  baseMap,
}: {
  headMap: Map<string, any> | undefined;
  baseMap: Map<string, any> | undefined;
}) {
  const [visibleRows, setVisibleRows] = useState({});

  function calculateTotals() {
    const totals = {
      id: "totals",
      workflow: "Total",
      job: "Total",
      failures: 0,
      skipped: 0,
      successes: 0,
      time: 0,
      timeChange: 0,
      failuresChange: 0,
      skippedChange: 0,
      successesChange: 0,
    };
    for (const value of headMap?.values() || []) {
      totals.successesChange += value.successesChange || 0;
      totals.skippedChange += value.skippedChange || 0;
      totals.failuresChange += value.failuresChange || 0;
      totals.failures += value.failures || 0;
      totals.skipped += value.skipped || 0;
      totals.successes += value.successes || 0;
      totals.timeChange += value.timeChange || 0;
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
          runner: value.runner,
          id: key,
        });
      }
      const headValue = headMap.get(key)!;
      headValue.timeChange = (headValue.time || 0) - value.time;
      headValue.failuresChange = (headValue.failures || 0) - value.failures;
      headValue.skippedChange = (headValue.skipped || 0) - value.skipped;
      headValue.successesChange = (headValue.successes || 0) - value.successes;
    }
  }

  function renderTimeCell(
    params: GridRenderCellParams<any, any, any, GridTreeNodeWithRender>
  ) {
    if (isNaN(params.value)) {
      return "";
    }
    return durationDisplay(parseFloat(params.value));
  }

  const columns: any[] = [
    {
      field: "job",
      headerName: "Job",
      flex: 4,
    },
    {
      field: "file",
      headerName: "file",
      flex: 2,
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
  ];

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
  const { data: info, error } = useClickHouseAPIImmutable<{ count: number }>(
    "tests/test_status_counts_on_commits_by_file",
    {
      shas: jobs.length > 0 ? [jobs[0].sha] : [],
      workflowIds: JSON.stringify([parseInt(workflowId)]),
    }
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

  const { data: comparisonInfo, error: comparisonInfoError } =
    useClickHouseAPIImmutable<{ count: number }>(
      "tests/test_status_counts_on_commits_by_file",
      {
        shas: jobs.length > 0 ? [jobs[0].sha] : [],
        workflowIds: JSON.stringify([
          comparisonId && parseInt(comparisonId[0].id),
        ]),
      },
      comparisonSha && comparisonId && comparisonId[0]
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
        />
      </Box>
    </div>
  );
}
