import useSWR from "swr";
import { fetcher } from "lib/GeneralUtils";
import React, { useState } from "react";
import { RocksetParam } from "lib/rockset";
import {
  Stack,
  Typography,
  Select,
  MenuItem,
  FormControl,
  Divider,
  InputLabel,
  SelectChangeEvent,
} from "@mui/material";

const queryCollection = "torchbench";
const MAX_COMMIT_SHAS = 10;
const SHA_DISPLAY_LENGTH = 10;

type UserbenchmarkRow = {
  metric_name: string;
  control_value: string | number;
  treatment_value: string | number;
  delta: string | number | null;
};

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

  let all_commits: string[] = data.map((r: any) => r["environ"]["pytorch_git_version"])
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
  function get_query_url(params: RocksetParam[]) {
    return `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
      JSON.stringify(params)
    )}`;
  }
  function query_metrics(url: string) {
    let { data, error } = useSWR(url, fetcher, {
      refreshInterval: 12 * 60 * 60 * 1000, // refresh every 12 hours
    });
    return data
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
  // We assume to return at least one instance for the query
  let cMetrics = query_metrics(get_query_url(queryControlParams))[0];
  let tMetrics = query_metrics(get_query_url(queryTreatmentParams))[0];

  return (
    <div> </div>);
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
