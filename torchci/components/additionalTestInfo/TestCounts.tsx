import { JobData } from "lib/types";
import { CSSProperties } from "react";
import _ from "lodash";
import useSWR from "swr";
import { fetcher } from "lib/GeneralUtils";
import { durationDisplay } from "components/TimeUtils";
import { DataGrid, GridRenderCellParams } from "@mui/x-data-grid";
import { RecursiveDetailsSummary } from "./TestInfo";

function TestCountsDataGrid({ info }: { info: any }) {
  return (
    <DataGrid
      initialState={{
        sorting: {
          sortModel: [{ field: "file", sort: "desc" }],
        },
      }}
      density={"compact"}
      rows={Object.keys(info).map((file) => {
        return {
          file: file,
          count: info[file].count,
          time: Math.round(info[file].time * 100) / 100,
          id: file,
        };
      })}
      columns={[
        { field: "file", headerName: "Name", flex: 3 },
        { field: "count", headerName: "Total Tests", flex: 1 },
        {
          field: "time",
          headerName: "Time",
          flex: 1,
          renderCell: (params: GridRenderCellParams<string>) => {
            const humanReadable = durationDisplay(
              params.value ? parseFloat(params.value) : 0
            );
            return <>{humanReadable}</>;
          },
        },
      ]}
      hideFooter={true}
      autoPageSize={false}
    />
  );
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
  const shouldShow =
    jobs.every((job) => job.conclusion !== "pending") &&
    jobs.some((job) => job.name!.includes("/ test "));
  const { data: info, error } = useSWR(
    shouldShow
      ? `https://ossci-raw-job-status.s3.amazonaws.com/additional_info/invoking_file_summary/${workflowId}/${runAttempt}`
      : null,
    fetcher
  );

  console.log(info);
  if (!shouldShow) {
    return <div>Workflow is still pending or there are no test jobs</div>;
  }

  if (error) {
    return <div>Error retrieving data {`${error}`}</div>;
  }

  if (!info) {
    return <div>Loading...</div>;
  }

  if (Object.keys(info).length == 0) {
    return <div>There was trouble parsing data</div>;
  }

  function getTestCountsTime(info: any): any {
    const keys = Object.keys(info);
    if (keys.includes("time") && keys.includes("count")) {
      return [
        {
          time: info.time,
          count: info.count,
        },
      ];
    }
    return keys.map((key) => {
      const subInfo = getTestCountsTime(info[key]);
      return {
        time: subInfo.reduce((prev: number, curr: any) => prev + curr.time, 0),
        count: subInfo.reduce(
          (prev: number, curr: any) => prev + curr.count,
          0
        ),
        file: key,
      };
    });
  }

  const divStyle: CSSProperties = {
    overflowY: "auto",
    height: "50vh",
    borderStyle: "solid",
    borderWidth: "1px",
    padding: "0em 0.5em",
  };
  return (
    <div>
      <div
        style={{ fontSize: "1.17em", fontWeight: "bold", paddingTop: "1em" }}
      >
        Test Times and Counts
      </div>
      <RecursiveDetailsSummary
        info={info}
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
              <TestCountsDataGrid info={testCountsTimeInfo} />
            </div>
          );
        }}
      >
        {(config: any, configInfo: any, numSiblings: number) => {
          return (
            <details>
              <summary>{config}</summary>
              <div style={{ paddingLeft: "1em" }}>
                <div style={divStyle}>
                  <TestCountsDataGrid info={configInfo} />
                </div>
              </div>
            </details>
          );
        }}
      </RecursiveDetailsSummary>
    </div>
  );
}
