import { DataGrid, GridRenderCellParams } from "@mui/x-data-grid";
import { durationDisplay } from "components/TimeUtils";
import { fetcher } from "lib/GeneralUtils";
import { JobData } from "lib/types";
import _ from "lodash";
import { CSSProperties, useState } from "react";
import useSWR from "swr";
import { genMessage, isPending, RecursiveDetailsSummary } from "./TestInfo";

function TestCountsDataGrid({
  info,
  showComparison,
}: {
  info: any;
  showComparison?: boolean;
}) {
  function renderTime(params: GridRenderCellParams<any, string>) {
    if (params.value === undefined) {
      return <></>;
    }
    const humanReadable = durationDisplay(
      params.value ? parseFloat(params.value) : 0
    );
    return <>{humanReadable}</>;
  }

  return (
    <DataGrid
      initialState={{
        sorting: {
          sortModel: [{ field: "file", sort: "desc" }],
        },
      }}
      density={"compact"}
      rows={Object.keys(info).map((file) => {
        const obj: any = {
          file: file,
          count: info[file].count,
          time: info[file].time && Math.round(info[file].time * 100) / 100,
          rawtime: info[file].time,
          id: file,
        };
        if (showComparison) {
          obj.comparisonCount = info[file].comparisonCount;
          obj.comparisonTime =
            info[file].comparisonTime &&
            Math.round(info[file].comparisonTime * 100) / 100;
          obj.diffCount =
            (info[file].count || 0) - (info[file].comparisonCount || 0);
          obj.diffTime =
            Math.round(
              ((info[file].time || 0) - (info[file].comparisonTime || 0)) * 100
            ) / 100;
        }
        return obj;
      })}
      columns={[
        { field: "file", headerName: "Name", flex: 4 },
        { field: "count", headerName: "Test Count", flex: 1 },
        {
          field: "time",
          headerName: "Test Time",
          flex: 1,
          renderCell: renderTime,
        },
        {
          field: "comparisonCount",
          headerName: "vs Test Count",
          flex: 1,
        },
        {
          field: "comparisonTime",
          headerName: "vs Test Time",
          flex: 1,
          renderCell: renderTime,
        },
        {
          field: "diffCount",
          headerName: "Δ Test Count",
          flex: 1,
          renderCell: (params) => {
            if (params.value === undefined) {
              return <></>;
            }
            if (parseInt(params.value) === 0) {
              return <></>;
            }
            return (
              <>
                {parseInt(params.value) > 0 && "+"}
                {params.value}
              </>
            );
          },
        },
        {
          field: "diffTime",
          headerName: "Δ Test Time",
          flex: 1,
          renderCell: (params) => {
            if (params.value === undefined) {
              return <></>;
            }
            if (parseFloat(params.value) === 0) {
              return <></>;
            }
            return (
              <>
                {parseFloat(params.value) > 0 ? "+" : "-"}
                {durationDisplay(Math.abs(parseFloat(params.value)))}
              </>
            );
          },
        },
      ]}
      hideFooter={true}
      autoPageSize={false}
    />
  );
}

function mergeComparisonInfo(info: any, comparisonInfo: any): any {
  if (!comparisonInfo) {
    return info;
  }
  const keys = Object.keys(comparisonInfo);
  if (keys.includes("time") && keys.includes("count")) {
    return {
      ...info,
      comparisonTime: comparisonInfo.time,
      comparisonCount: comparisonInfo.count,
    };
  }
  let newInfo = info || {};
  keys.forEach((key) => {
    newInfo[key] = {
      ...mergeComparisonInfo(newInfo[key], comparisonInfo[key]),
    };
  });
  return newInfo;
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

function getTestCountsTime(info: any): any {
  function reduce(info: any, field: string): any {
    if (info.length == 0 || info.every((x: any) => x[field] == undefined)) {
      return undefined;
    }
    return info.reduce(
      (prev: number, curr: any) => prev + (curr[field] || 0),
      0
    );
  }
  const keys = Object.keys(info);
  if (
    keys.some((key) =>
      ["time", "count", "comparisonCount", "comparisonTime"].includes(key)
    )
  ) {
    return [
      {
        time: info.time,
        count: info.count,
        comparisonCount: info.comparisonCount,
        comparisonTime: info.comparisonTime,
      },
    ];
  }
  return keys.map((key) => {
    const subInfo = getTestCountsTime(info[key]);
    return {
      file: key,
      time: reduce(subInfo, "time"),
      count: reduce(subInfo, "count"),
      comparisonCount: reduce(subInfo, "comparisonCount"),
      comparisonTime: reduce(subInfo, "comparisonTime"),
    };
  });
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
  const mergedInfo = mergeComparisonInfo(info, comparisonInfo);

  const divStyle: CSSProperties = {
    overflowY: "auto",
    height: "50vh",
    borderStyle: "solid",
    borderWidth: "1px",
    padding: "0em 0.5em",
  };
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
      <RecursiveDetailsSummary
        info={mergedInfo}
        level={1}
        bodyFunction={(name: any, info: any) => {
          const testCountsTimeInfo = _.keyBy(getTestCountsTime(info), "file");
          return (
            <div
              style={{
                ...divStyle,
                height: `15vh`,
              }}
            >
              <TestCountsDataGrid
                info={testCountsTimeInfo}
                showComparison={comparisonInfo}
              />
            </div>
          );
        }}
      >
        {(config: any, configInfo: any, _numSiblings: number) => {
          return (
            <details>
              <summary>{config}</summary>
              <div style={{ paddingLeft: "1em" }}>
                <div style={divStyle}>
                  <TestCountsDataGrid
                    info={configInfo}
                    showComparison={comparisonInfo}
                  />
                </div>
              </div>
            </details>
          );
        }}
      </RecursiveDetailsSummary>
    </div>
  );
}
