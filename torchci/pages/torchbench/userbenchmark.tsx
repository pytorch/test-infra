import useSWR from "swr";
import { fetcher } from "lib/GeneralUtils";
import React, { useState } from "react";
import {
  Stack,
  Typography,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  SelectChangeEvent,
} from "@mui/material";

const queryCollection = "torchbench";

type UserbenchmarkRow = {
  metric_name: string;
  control_value: string | number;
  treatment_value: string | number;
  delta: string | number | null;
};

export function UserbenchmarkPicker({
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

export default function Page() {
  const defaultUB = "torch-nightly"
  const [userbenchmark, setUserbenchmark] = useState(defaultUB);
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
    </Stack>
  </div>;
}
