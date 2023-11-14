import useSWR from "swr";
import { fetcher } from "lib/GeneralUtils";
import React, { useState } from "react";
import { RocksetParam } from "lib/rockset";
import {
  Grid,
  Stack,
  Typography,
  Select,
  MenuItem,
  FormControl,
  Divider,
  InputLabel,
  SelectChangeEvent,
} from "@mui/material";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import {
  GridRenderCellParams,
  GridCellParams,
} from "@mui/x-data-grid";
import styles from "components/metrics.module.css";

const queryCollection = "torchbench";
const ROW_GAP = 30;
const ROW_HEIGHT = 48;
const MIN_ENTRIES = 10;
const MAX_COMMIT_SHAS = 10;
const SHA_DISPLAY_LENGTH = 10;

function UserbenchmarkPicker({
  userbenchmark,
  setUserbenchmark
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
    data = [ {
      "name": "API error"
    }];
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
  fallbackIndex
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
  if (data === undefined || data.length === 0) {
    data = [ {
      "name": "api_error",
      "environ": {
        "pytorch_git_version": "api_error",
      }
    }];
    commit = "api_error";
  }

  let all_commits: string[] = data.map((r: any) => r["pytorch_git_version"])
      .filter((s: any) => s !== undefined)
      .sort((x: string, y: string) => x < y ? -1 : 1).slice(0, MAX_COMMIT_SHAS)

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
          {all_commits.map((r: any) => (
             <MenuItem key={r} value={r}>
             {r.substring(0, SHA_DISPLAY_LENGTH)}
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
  rCommit
}: {
    userbenchmark: string;
    lCommit: string;
    rCommit: string;
}) {
  function getQueryUrl(params: RocksetParam[]) {
    return `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
      JSON.stringify(params)
    )}`;
  }
  function QueryMetrics(url: string) {
    let { data, error } = useSWR(url, fetcher, {
      refreshInterval: 12 * 60 * 60 * 1000, // refresh every 12 hours
    });
    return data
  }

  function genABMetrics(cMetrics: any, tMetrics: any): Record<string, any>[] {
    // Return a list of metrics that are the union of cMetrics and tMetrics
    cMetrics = (cMetrics === undefined) ? {} : cMetrics;
    tMetrics = (tMetrics === undefined) ? {} : tMetrics;
    let cMetricNames: string[] = "metrics" in cMetrics ? Array.from(Object.keys(cMetrics["metrics"])) : [];
    let tMetricNames: string[] = "metrics" in tMetrics ? Array.from(Object.keys(tMetrics["metrics"])) : [];
    const metricNameSet: Set<string> = new Set([...cMetricNames, ...tMetricNames]);
    let metricNames = Array.from(metricNameSet).sort();
    const data = metricNames.map((name: string) => {
      const hasL = (cMetrics === undefined || !("metrics" in cMetrics)) ? false : name in cMetrics["metrics"];
      const hasR = (tMetrics === undefined || !("metrics" in tMetrics)) ? false : name in tMetrics["metrics"];

      const delta = (hasL && hasR) ?
                    (tMetrics["metrics"][name] - cMetrics["metrics"][name]) / cMetrics["metrics"][name] :
                    "undefined";
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
        }
      };
    });
    return data;
  }

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
      value: lCommit,
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
      value: rCommit,
    },
  ];
  // We only submit the query if both commit IDs are available
  if (lCommit.length === 0 || rCommit.length === 0) {
    return (<div>
      Error: we require both commits to be available: left {lCommit} and right {rCommit}.
    </div>);
  }
  let cMetrics = QueryMetrics(getQueryUrl(queryControlParams));
  cMetrics = (cMetrics === undefined) ? {} : cMetrics[0];
  let tMetrics = QueryMetrics(getQueryUrl(queryTreatmentParams));
  tMetrics = (tMetrics === undefined) ? {} : tMetrics[0];
  const metrics: Record<string, any>[] = genABMetrics(cMetrics, tMetrics);
  const minEntries = metrics.length > MIN_ENTRIES ? Object.keys(metrics).length : MIN_ENTRIES;

  return (
    <div>
       <Grid container spacing={2} style={{ height: "100%" }}>
       <Grid item xs={12} lg={12} height={minEntries * ROW_HEIGHT + ROW_GAP}>
          <TablePanelWithData
           title={"Metrics"}
           data={metrics}
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
                return <>
                      <a href="#">
                        <b>{params.value.name}</b>
                      </a>
                </>
              }
            },
            {
              field: "control",
              headerName: "Base Commit (" + lCommit.substring(0, SHA_DISPLAY_LENGTH) + ")",
              flex: 1,
              cellClassName: (params: GridCellParams<any>) => {
                const v = params.value.v;
                if (v === undefined) {
                  return "";
                }
                return v;
              },
              renderCell: (params: GridRenderCellParams<any>) => {
                return <>
                    {params.value.v}
                </>
              }
            },
            {
              field: "treatment",
              headerName: "Head Commit (" + rCommit.substring(0, SHA_DISPLAY_LENGTH) + ")",
              flex: 1,
              cellClassName: (params: GridCellParams<any>) => {
                const v = params.value.v;
                if (v === undefined) {
                  return "";
                }
                return v;
              },
              renderCell: (params: GridRenderCellParams<any>) => {
                return <>
                    {params.value.v}
                </>
              }
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
                return <>
                    {params.value.v}
                </>
              }
            },
           ]}
           dataGridProps={{ getRowId: (el: any) => el.name }}
          />
       </Grid>
       </Grid>
    </div>);
}

export default function Page() {
  const defaultUB = "torch-nightly"
  const [userbenchmark, setUserbenchmark] = useState(defaultUB);
  const [lCommit, setLCommit] = useState<string>("");
  const [rCommit, setRCommit] = useState<string>("");

  return <div>
    <Typography fontSize={"2rem"} fontWeight={"bold"}>
      TorchBench Userbenchmark Dashboard
    </Typography>
    <p>
      TorchBench Userbenchmarks can be run in the CI deployed in the pytorch/benchmark
      repo. <br/> The CI job will generate a JSON of the results, showing result times
      from the control revision as well as the treatment revision.
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
        fallbackIndex={-1} // Default to the next to latest in the window
      />
      <Divider orientation="vertical" flexItem>
          &mdash;Diff→
      </Divider>
      <CommitPicker
        userbenchmark={userbenchmark}
        commit={rCommit}
        setCommit={setRCommit}
        titlePrefix={"New"}
        fallbackIndex={0} // Default to the latest in the window
      />
    </Stack>

    <Report
        userbenchmark={userbenchmark}
        lCommit={lCommit}
        rCommit={rCommit}
      />
  </div>;
}
