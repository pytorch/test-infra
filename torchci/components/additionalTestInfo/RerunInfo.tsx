import ErrorIcon from "@mui/icons-material/Error";
import WarningRoundedIcon from "@mui/icons-material/WarningRounded";
import { Stack, Tooltip, Typography } from "@mui/material";
import { DataGrid, GridEventListener } from "@mui/x-data-grid";
import { fetcher } from "lib/GeneralUtils";
import { JobData } from "lib/types";
import _ from "lodash";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { genMessage, isPending } from "./TestInfo";

function groupByStatus(info: any) {
  const tests: any[] = [];
  _.forIn(info, (value, build) => {
    _.forIn(value, (value, testConfig) => {
      _.forIn(value, (value, invokingFile) => {
        _.forIn(value, (value, className) => {
          _.forIn(value, (value, testName) => {
            const [failures, successes] = _.partition(value, (i) => i.failure);
            const failuresWithReruns = failures.concat(
              _(value)
                .filter((i: any) => i.rerun)
                .map((i) => {
                  if (!Array.isArray(i.rerun)) {
                    i.rerun = [i.rerun];
                  }
                  return i.rerun.map((rerun: any) => ({
                    failure: rerun,
                    job_id: i.job_id,
                  }));
                })
                .flatten()
                .value()
            );
            if (failuresWithReruns.length != 0) {
              const status = successes.length > 0 ? "flaky" : "failed";
              tests.push({
                build,
                testConfig,
                invokingFile,
                className,
                testName,
                info: failuresWithReruns.concat(successes),
                id: tests.length,
                status: status,
              });
            }
          });
        });
      });
    });
  });
  return _.keyBy(tests, (t) => t.id);
}

function Icon({ status }: { status: string }) {
  if (status === "failed") {
    return <ErrorIcon color="error" />;
  } else if (status === "flaky") {
    return <WarningRoundedIcon sx={{ color: "orange" }} />;
  } else {
    return <></>;
  }
}

function IndividualInfo({ test }: { test: any }) {
  const [failures, successes] = _.partition(test.info, (i) => i.failure);

  const [trackbacksToShow, setTrackbacksToShow] = useState(new Set());
  useEffect(() => {
    // Reset the trackbacks when a different test is clicked
    setTrackbacksToShow(new Set());
  }, [test]);

  const params = [
    { field: "testName", title: "Test Name" },
    { field: "className", title: "Test Class" },
    { field: "invokingFile", title: "Test File" },
    { field: "testConfig", title: "Test Config" },
    { field: "build", title: "Build" },
  ];
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={2} alignItems={"center"}>
        <Icon status={test.status} />
        <div>{test.status}</div>
      </Stack>
      {params.map((param) => {
        return (
          <div key={param.field}>
            <span style={{ fontWeight: "bold" }}>{param.title}: </span>
            {test[param.field]}
          </div>
        );
      })}
      {failures.map((i: any, ind: number) => {
        return (
          <div key={ind}>
            <a
              href="javascript:void(0)"
              onClick={() => {
                if (trackbacksToShow.has(ind)) {
                  const newSet = new Set(trackbacksToShow);
                  newSet.delete(ind);
                  setTrackbacksToShow(newSet);
                } else {
                  setTrackbacksToShow(new Set(trackbacksToShow).add(ind));
                }
              }}
            >
              Show Traceback #{ind + 1}
            </a>
            {" on"}
            <a href={`#${i.job_id}-box`}> job {i.job_id}</a>
            {trackbacksToShow.has(ind) && (
              <div>
                <pre
                  style={{
                    overflow: "auto",
                  }}
                >
                  {i.failure.text}
                </pre>
              </div>
            )}
          </div>
        );
      })}
      {successes.map((i: any, ind: number) => {
        return (
          <div key={ind}>
            <span>Succeeded on</span>
            <a href={`#${i.job_id}-box`}> job {i.job_id}</a>
          </div>
        );
      })}
    </Stack>
  );
}

export default function Info({ tests }: { tests: _.Dictionary<any> }) {
  const [clicked, setClicked] = useState(-1);

  const renderCell = (params: any) => (
    <Tooltip title={params.value}>
      <span>{params.value}</span>
    </Tooltip>
  );
  const columns = [
    {
      field: "status",
      headerName: "Status",
      flex: 0.1,
      renderCell: (params: any) => (
        <Tooltip title={params.value}>
          <Icon status={params.value} />
        </Tooltip>
      ),
    },
    { field: "testName", headerName: "Test Name", flex: 2, renderCell },
    { field: "className", headerName: "Test Class", flex: 1, renderCell },
    { field: "invokingFile", headerName: "Test File", flex: 1, renderCell },
    { field: "testConfig", headerName: "Test Config", flex: 1, renderCell },
    { field: "build", headerName: "Build", flex: 1, renderCell },
  ];

  const handleEvent: GridEventListener<"rowClick"> = (
    params,
    _event,
    _details
  ) => {
    setClicked(params.row.id);
  };

  const paperStyle = {
    width: "100%",
    height: "100%",
    backgroundColor: "white",
    overflow: "auto",
  };
  return (
    <Stack spacing={1} height={600} direction={"row"}>
      <div style={paperStyle}>
        <DataGrid
          rows={_.sortBy(_.values(tests), (t) => t.status)}
          columns={columns}
          density="compact"
          onRowClick={handleEvent}
        />
      </div>
      {clicked != -1 && (
        <div style={{ ...paperStyle, padding: "1em" }}>
          <IndividualInfo test={tests[clicked]} />
        </div>
      )}
    </Stack>
  );
}

export function TestRerunsInfo({
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
      ? `https://ossci-raw-job-status.s3.amazonaws.com/additional_info/reruns/${workflowId}/${runAttempt}`
      : null,
    fetcher
  );

  if (!shouldShow) {
    return <div>Workflow is still pending or there are no test jobs</div>;
  }
  const infoString = "No tests were rerun or there was trouble parsing data";

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
  const tests = groupByStatus(info);

  return (
    <Stack spacing={1} paddingTop={"1em"}>
      <Typography style={{ fontSize: "1.17em", fontWeight: "bold" }}>
        Info about tests that got rerun
      </Typography>
      {isPending(jobs) && (
        <div>Workflow is still pending. Data may be incomplete.</div>
      )}
      <Info tests={tests} />
    </Stack>
  );
}
