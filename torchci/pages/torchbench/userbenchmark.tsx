import {
  Divider,
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import { GridCellParams, GridRenderCellParams } from "@mui/x-data-grid";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import dayjs from "dayjs";
import { fetcher } from "lib/GeneralUtils";
import { RocksetParam } from "lib/rockset";
import { useEffect, useState } from "react";
import useSWR from "swr";

const queryCollection = "torchbench";
const ROW_GAP = 30;
const ROW_HEIGHT = 48;
const MIN_ENTRIES = 10;
const MAX_ENTRIES = 100;
const MAX_PYTORCH_VERSIONS = 30;
const SHA_DISPLAY_LENGTH = 10;

function getShortDateFromDateString(dateString: string): string {
  const d = dayjs(dateString);
  return d.format("YYYY-MM-DD HH:mm:ss");
}

function UserbenchmarkPicker({
  userbenchmark,
  setUserbenchmark,
}: {
  userbenchmark: string;
  setUserbenchmark: any;
}) {
  function handleChange(e: SelectChangeEvent<string>) {
    setUserbenchmark(e.target.value);
  }
  const queryName = "torchbench_list_userbenchmarks";
  const queryParams: any[] = [];
  const list_userbenchmark_url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  let { data, error } = useSWR(list_userbenchmark_url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });
  if (data === undefined || data.length === 0) {
    data = [
      {
        name: "API error",
      },
    ];
    userbenchmark = "API error";
  }
  return (
    <>
      <FormControl>
        <InputLabel id="ub-picker-input-label">Userbenchmark</InputLabel>
        <Select
          value={userbenchmark}
          label="Userbenchmark"
          labelId="ub-picker-select-label"
          id="ub-picker-select"
          onChange={handleChange}
        >
          {Object.keys(data).map((ub) => (
            <MenuItem key={data[ub]["name"]} value={data[ub]["name"]}>
              {data[ub]["name"]}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </>
  );
}

function CommitPicker({
  userbenchmark,
  commit,
  setCommit,
  titlePrefix,
  fallbackIndex,
}: {
  userbenchmark: string;
  commit: string;
  setCommit: any;
  titlePrefix: string;
  fallbackIndex: number;
}) {
  function handleCommitChange(e: SelectChangeEvent<string>) {
    setCommit(e.target.value);
  }

  function objToCommitDesc(data: any) {
    if (
      data["pytorch_git_version"] === undefined ||
      data["pytorch_commit_time"] === undefined
    ) {
      return "";
    }
    return (
      getShortDateFromDateString(data["pytorch_commit_time"]) +
      " (" +
      data["pytorch_git_version"].substring(0, SHA_DISPLAY_LENGTH) +
      ")"
    );
  }

  function commitDescToDate(desc: string) {
    const [firstGroup] = desc.split(" ");
    return firstGroup;
  }

  const queryName = "torchbench_userbenchmark_list_commits";
  const queryCollection = "torchbench";
  const queryParams: RocksetParam[] = [
    {
      name: "userbenchmark",
      type: "string",
      value: userbenchmark,
    },
  ];
  const list_commits_url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  let { data, error } = useSWR(list_commits_url, fetcher, {
    refreshInterval: 12 * 60 * 60 * 1000, // refresh every 12 hours
  });

  useEffect(() => {
    if (data !== undefined && data.length !== 0) {
      const allCommits: string[] = data
        .map((r: any) => objToCommitDesc(r))
        .filter((s: any) => s !== undefined)
        .sort((x: string, y: string) =>
          commitDescToDate(x) < commitDescToDate(y) ? 1 : -1
        )
        .slice(0, MAX_PYTORCH_VERSIONS);

      if (commit === undefined || commit === "" || commit.length === 0) {
        if (allCommits.length === 1) {
          fallbackIndex = 0;
        }
        const index = (allCommits.length + fallbackIndex) % allCommits.length;
        const desc = objToCommitDesc(allCommits[index]);
        setCommit(desc);
      }
    }
  }, [data]);

  if (error !== undefined) {
    return (
      <div>
        An error occurred while fetching data, perhaps there are too many
        results with your choice of userbenchmark?
      </div>
    );
  }
  if (data === undefined || data.length === 0) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const allCommits: string[] = data
    .map((r: any) => objToCommitDesc(r))
    .filter((s: any) => s !== undefined)
    .sort((x: string, y: string) =>
      commitDescToDate(x) < commitDescToDate(y) ? 1 : -1
    )
    .slice(0, MAX_PYTORCH_VERSIONS);

  return (
    <div>
      <FormControl>
        <InputLabel id={`commit-picker-input-label-${commit}`}>
          {titlePrefix} Commit
        </InputLabel>
        <Select
          value={commit}
          label="Commit"
          labelId={`commit-picker-select-label-${commit}`}
          onChange={handleCommitChange}
          id={`commit-picker-select-${commit}`}
        >
          {allCommits.map((r: any) => (
            <MenuItem key={r} value={r}>
              {r}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </div>
  );
}

function Report({
  userbenchmark,
  lCommit,
  rCommit,
}: {
  userbenchmark: string;
  lCommit: string;
  rCommit: string;
}) {
  function getCommitHash(commitDesc: string): string {
    if (commitDesc === undefined) {
      return "";
    }
    const regex = /\((.*)\)/;
    const matches = commitDesc.match(regex);
    if (matches && matches.length > 1) {
      return matches[1];
    }
    return "";
  }

  function getQueryUrl(params: RocksetParam[]) {
    return `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
      JSON.stringify(params)
    )}`;
  }
  function QueryMetrics(url: string) {
    let { data, error } = useSWR(url, fetcher, {
      refreshInterval: 12 * 60 * 60 * 1000, // refresh every 12 hours
    });
    return data;
  }

  function genABMetrics(cMetrics: any, tMetrics: any): Record<string, any>[] {
    // Return a list of metrics that are the union of cMetrics and tMetrics
    cMetrics = cMetrics === undefined ? {} : cMetrics;
    tMetrics = tMetrics === undefined ? {} : tMetrics;
    let cMetricNames: string[] =
      "metrics" in cMetrics ? Array.from(Object.keys(cMetrics["metrics"])) : [];
    let tMetricNames: string[] =
      "metrics" in tMetrics ? Array.from(Object.keys(tMetrics["metrics"])) : [];
    const metricNameSet: Set<string> = new Set([
      ...cMetricNames,
      ...tMetricNames,
    ]);
    let metricNames = Array.from(metricNameSet).sort();
    const data = metricNames.map((name: string) => {
      const hasL =
        cMetrics === undefined || !("metrics" in cMetrics)
          ? false
          : name in cMetrics["metrics"];
      const hasR =
        tMetrics === undefined || !("metrics" in tMetrics)
          ? false
          : name in tMetrics["metrics"];

      const delta =
        hasL && hasR
          ? (tMetrics["metrics"][name] - cMetrics["metrics"][name]) /
            cMetrics["metrics"][name]
          : "undefined";
      return {
        // Keep the name as as the row ID as DataGrid requires it
        name: name,

        // The metrics name
        metadata: {
          name: name,
        },

        // The metrics value on base commit
        control: {
          name: name,
          v: hasL ? cMetrics["metrics"][name] : "undefined",
        },

        // The metrics value on head commit
        treatment: {
          name: name,
          v: hasR ? tMetrics["metrics"][name] : "undefined",
        },

        // The metrics value delta
        delta: {
          name: name,
          v: delta,
        },
      };
    });
    return data;
  }

  const lCommitHash: string = getCommitHash(lCommit);
  const rCommitHash: string = getCommitHash(rCommit);

  const queryName = "torchbench_userbenchmark_query_metrics";
  const queryCollection = "torchbench";
  const queryControlParams: RocksetParam[] = [
    {
      name: "userbenchmark",
      type: "string",
      value: userbenchmark,
    },
    {
      name: "commit",
      type: "string",
      value: lCommitHash,
    },
  ];
  const queryTreatmentParams: RocksetParam[] = [
    {
      name: "userbenchmark",
      type: "string",
      value: userbenchmark,
    },
    {
      name: "commit",
      type: "string",
      value: rCommitHash,
    },
  ];
  // We only submit the query if both commit IDs are available
  if (lCommitHash.length === 0 || rCommitHash.length === 0) {
    return <div>Please select both left and right commits.</div>;
  }
  let cMetrics = QueryMetrics(getQueryUrl(queryControlParams));
  cMetrics = cMetrics === undefined ? {} : cMetrics[0];
  let tMetrics = QueryMetrics(getQueryUrl(queryTreatmentParams));
  tMetrics = tMetrics === undefined ? {} : tMetrics[0];
  const metrics: Record<string, any>[] = genABMetrics(cMetrics, tMetrics);
  const minEntries =
    metrics.length > MIN_ENTRIES
      ? Object.keys(metrics).length > MAX_ENTRIES
        ? MAX_ENTRIES
        : Object.keys(metrics).length
      : MIN_ENTRIES;

  return (
    <div>
      <Grid container spacing={2} style={{ height: "100%" }}>
        <Grid item xs={12} lg={12} height={minEntries * ROW_HEIGHT + ROW_GAP}>
          <TablePanelWithData
            title={"Metrics"}
            data={metrics}
            showFooter={true}
            columns={[
              {
                field: "metadata",
                headerName: "Metrics Name",
                flex: 1,
                cellClassName: (params: GridCellParams<any>) => {
                  const name = params.value.name;
                  if (name === undefined) {
                    return "";
                  }
                  return name;
                },
                renderCell: (params: GridRenderCellParams<any>) => {
                  return (
                    <>
                      <a href="#">
                        <b>{params.value.name}</b>
                      </a>
                    </>
                  );
                },
              },
              {
                field: "control",
                headerName: "Base Commit: " + lCommit,
                flex: 1,
                cellClassName: (params: GridCellParams<any>) => {
                  const v = params.value.v;
                  if (v === undefined) {
                    return "";
                  }
                  return v;
                },
                renderCell: (params: GridRenderCellParams<any>) => {
                  return <>{params.value.v}</>;
                },
              },
              {
                field: "treatment",
                headerName: "New Commit: " + rCommit,
                flex: 1,
                cellClassName: (params: GridCellParams<any>) => {
                  const v = params.value.v;
                  if (v === undefined) {
                    return "";
                  }
                  return v;
                },
                renderCell: (params: GridRenderCellParams<any>) => {
                  return <>{params.value.v}</>;
                },
              },
              {
                field: "delta",
                headerName: "Value Delta",
                flex: 1,
                cellClassName: (params: GridCellParams<any>) => {
                  const v = params.value.v;
                  if (v === undefined) {
                    return "";
                  }
                  return v;
                },
                renderCell: (params: GridRenderCellParams<any>) => {
                  return <>{params.value.v}</>;
                },
              },
            ]}
            dataGridProps={{
              getRowId: (el: any) => el.name,
            }}
          />
        </Grid>
      </Grid>
    </div>
  );
}

export default function Page() {
  const defaultUB = "torch-nightly";
  const [userbenchmark, setUserbenchmark] = useState(defaultUB);
  const [lCommit, setLCommit] = useState<string>("");
  const [rCommit, setRCommit] = useState<string>("");

  return (
    <div>
      <Typography fontSize={"2rem"} fontWeight={"bold"}>
        TorchBench Userbenchmark Dashboard
      </Typography>
      <p>
        TorchBench Userbenchmarks can be run in the CI deployed in the
        pytorch/benchmark repo. <br /> The CI job will generate a JSON of the
        results, showing result times from the control revision as well as the
        treatment revision.
      </p>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <UserbenchmarkPicker
          userbenchmark={userbenchmark}
          setUserbenchmark={setUserbenchmark}
        />
        <CommitPicker
          userbenchmark={userbenchmark}
          commit={lCommit}
          setCommit={setLCommit}
          titlePrefix={"Base"}
          fallbackIndex={-1} // default to the second latest commit available
        />
        <Divider orientation="vertical" flexItem>
          &mdash;Diff→
        </Divider>
        <CommitPicker
          userbenchmark={userbenchmark}
          commit={rCommit}
          setCommit={setRCommit}
          titlePrefix={"New"}
          fallbackIndex={0} // default to the latest commit available
        />
      </Stack>

      <Report
        userbenchmark={userbenchmark}
        lCommit={lCommit}
        rCommit={rCommit}
      />
    </div>
  );
}
