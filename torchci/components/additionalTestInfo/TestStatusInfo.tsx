import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import WarningRoundedIcon from "@mui/icons-material/WarningRounded";
import {
  Box,
  Button,
  Pagination,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { DataGrid, GridColDef, GridEventListener } from "@mui/x-data-grid";
import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import _ from "lodash";
import { useEffect, useState } from "react";

function Icon({ status }: { status: string }) {
  let icon = null;
  if (status === "failure") {
    icon = <ErrorIcon sx={{ color: "red" }} />;
  } else if (status === "flaky") {
    icon = <WarningRoundedIcon sx={{ color: "orange" }} />;
  } else if (status === "success") {
    icon = <CheckCircleIcon sx={{ color: "green" }} />;
  } else if (status === "skipped") {
    icon = <WarningRoundedIcon sx={{ color: "grey" }} />;
  }
  return icon;
}

export function TestStatusInfo({
  workflowId,
  runAttempt,
}: {
  workflowId: string;
  runAttempt: string;
}) {
  const [page, setPage] = useState(1);
  const [count, setCount] = useState(0);
  const [searchString, setSearchString] = useState("");
  const [clicked, setClicked] = useState(-1);

  const fetchedCount = useClickHouseAPIImmutable<{ count: number }>(
    "tests/test_counts_on_commit",
    {
      workflowId: parseInt(workflowId),
      runAttempt: parseInt(runAttempt),
      searchString: searchString,
    }
  ).data?.[0]?.count;

  useEffect(() => {
    if (fetchedCount !== undefined) {
      setCount(fetchedCount);
    }
  }, [fetchedCount]);

  const { data, isLoading } = useClickHouseAPIImmutable<{ [key: string]: any }>(
    "tests/test_statuses_on_commit",
    {
      workflowId: parseInt(workflowId),
      runAttempt: parseInt(runAttempt),
      searchString: searchString,
      offset: (page - 1) * 100,
      per_page: 100,
    }
  );
  data?.forEach((_, index) => {
    data[index].id = index;
  });

  const columns: GridColDef[] = [
    {
      field: "status",
      headerName: "Status",
      flex: 1,
      renderCell: (params) => {
        const status = params.value;
        return (
          <Stack direction="row" spacing={1} alignItems="center">
            <Icon status={status} />
            <span>{status.charAt(0).toUpperCase() + status.slice(1)}</span>
          </Stack>
        );
      },
    },
    { field: "name", headerName: "Name", flex: 5 },
    { field: "classname", headerName: "Classname", flex: 3 },
    { field: "invoking_file", headerName: "Invoking File", flex: 3 },
    { field: "job_name", headerName: "Job Name", flex: 3 },
  ];

  const handleEvent: GridEventListener<"rowClick"> = (
    params,
    _event,
    _details
  ) => {
    if (clicked === params.row.id) {
      setClicked(-1);
      return;
    }
    setClicked(params.row.id);
  };
  const paperStyle = {
    width: "100%",
    height: "100%",
    backgroundColor: "white",
    overflow: "auto",
  };
  return (
    <Stack spacing={2}>
      <Typography variant="h6">Test Status Information</Typography>
      <Box
        component="form"
        noValidate
        autoComplete="off"
        sx={{
          "& .MuiTextField-root": {
            marginRight: 1,
            width: "25ch",
          },
          "& .MuiButton-root": {
            marginTop: 1,
            marginBottom: 1,
            marginLeft: 2,
          },
        }}
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const searchValue = data.get("search") as string;
          setSearchString(searchValue);
          setPage(1);
          setClicked(-1);
        }}
      >
        <TextField label="Search Tests" name="search" />
        <Button variant="contained" color="primary" type="submit">
          Search
        </Button>
      </Box>
      <Stack direction="row" alignItems="center">
        <Typography variant="body1" sx={{ marginRight: 2 }}>
          Showing {page * 100 - 99}-{Math.min(page * 100, count)} of {count}{" "}
          tests
        </Typography>
        <Pagination
          count={count ? Math.ceil(count / 100) : 0}
          page={page}
          onChange={(_e, value) => {
            setPage(value);
            setClicked(-1);
          }}
        />
      </Stack>
      <Stack spacing={1} height={600} direction={"row"}>
        <div style={paperStyle}>
          <DataGrid
            loading={isLoading}
            sx={{ "&:last-child td, &:last-child th": { border: 0 } }}
            rows={data || []}
            columns={columns}
            density={"compact"}
            hideFooter={true}
            getRowId={(row) =>
              `${row.name}-${row.classname}-${row.file}-${row.invoking_file}`
            }
            pagination={undefined}
            onRowClick={handleEvent}
            disableColumnFilter
            disableColumnSelector
            disableColumnMenu
            disableColumnSorting
          />
        </div>
        {clicked != -1 && (
          <div style={{ ...paperStyle, padding: "1em" }}>
            <IndividualInfo
              test={data ? data[clicked] : null}
              workflow_id={parseInt(workflowId)}
              run_attempt={parseInt(runAttempt)}
            />
          </div>
        )}
      </Stack>
    </Stack>
  );
}

function IndividualInfo({
  test,
  workflow_id,
  run_attempt,
}: {
  test: any;
  workflow_id: number;
  run_attempt: number;
}) {
  const { data, isLoading } = useClickHouseAPIImmutable<{ [key: string]: any }>(
    "tests/test_on_commit",
    {
      testName: test.name,
      className: test.classname,
      invokingFile: test.invoking_file,
      workflowId: workflow_id,
      runAttempt: run_attempt,
      jobName: test.job_name,
    }
  );

  const groupedData = _.groupBy(data, (i) => i.job_id);

  const mappedValues = _.mapValues(groupedData, (value) => {
    const job_id = value[0].job_id;
    const successes = _.filter(
      value,
      (i) =>
        i.failure.length === 0 && i.error.length === 0 && i.skipped.length === 0
    );
    const failures = _.flatten(
      _.map(value, (i) => i.failure.concat(i.error).concat(i.rerun))
    );
    const skips = _.flatten(_.map(value, (i) => i.skipped));
    return { successes, failures, skips, job_id };
  });

  const params = [
    { field: "name", title: "Test Name" },
    { field: "classname", title: "Test Class" },
    { field: "invoking_file", title: "Test File" },
    { field: "job_name", title: "Build" },
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
      {isLoading && <div>Loading test details...</div>}
      {Object.values(mappedValues).map((i: any, ind: number) => {
        const { successes, failures, job_id, skips } = i;

        return (
          <Stack key={"job-" + ind} spacing={1}>
            {failures.map((i: any, ind: number) => {
              return (
                <TraceBack
                  text={i.text}
                  jobId={job_id}
                  ind={ind + 1}
                  key={"failure-" + ind}
                />
              );
            })}
            {skips.map((i: any, ind: number) => {
              return (
                <Stack key={"skip-" + ind} spacing={1}>
                  <a href={`#${job_id}-box`}>Skipped on job {job_id}</a>
                  <MonospaceDisplay text={i.text} />
                </Stack>
              );
            })}
            {successes.map((i: any, ind: number) => {
              return (
                <a href={`#${job_id}-box`} key={"success-" + ind}>
                  Success on job {job_id}
                </a>
              );
            })}
          </Stack>
        );
      })}
    </Stack>
  );
}

function TraceBack({
  text,
  jobId,
  ind,
}: {
  text: string;
  jobId: number;
  ind: number;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
  }, [text]);

  return (
    <>
      <Stack direction="row" spacing={1}>
        <Button
          onClick={() => {
            setOpen(!open);
          }}
          variant="text"
          sx={{
            textTransform: "none",
            textDecoration: "underline",
            padding: 0,
          }}
        >
          Show Traceback #{ind}
        </Button>
        <span>on</span>
        <a href={`#${jobId}-box`}>job {jobId}</a>
      </Stack>
      {open && <MonospaceDisplay text={text} />}
    </>
  );
}

function MonospaceDisplay({ text }: { text: string }) {
  return (
    <Box
      sx={{
        backgroundColor: "#f5f5f5",
        padding: "10px",
        borderRadius: "5px",
        marginTop: "10px",
        display: "flex",
        alignItems: "center",
      }}
      overflow={"auto"}
    >
      <Typography
        sx={{
          fontFamily: "monospace",
          whiteSpace: "pre",
          overflowX: "auto",
          flexGrow: 1,
        }}
      >
        {text}
      </Typography>
    </Box>
  );
}
