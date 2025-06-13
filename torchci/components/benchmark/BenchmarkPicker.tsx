import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  Skeleton,
} from "@mui/material";

import { fetcher } from "lib/GeneralUtils";
import { useEffect } from "react";
import useSWR from "swr";

export function BenchmarkPicker({
  queryName,
  queryParams,
  benchmarkName,
  setBenchmarkName,
}: {
  queryName: string;
  queryParams: { [k: string]: any };
  benchmarkName: string;
  setBenchmarkName: any;
}) {
  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  let { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  useEffect(() => {
    if (data !== undefined && data.length !== 0) {
      const benchmarks = data.map((item: any) => item.name).sort();
      if (!benchmarks.includes(benchmarkName)) {
        benchmarkName = benchmarks[0];
        // Fallback to the main branch or the first available branch found in result
        setBenchmarkName(benchmarkName);
      }
    }
  }, [data]);

  if (error !== undefined) {
    return (
      <div>
        An error occurred while fetching data, perhaps there are too many
        results with your choice of time range and granularity?
      </div>
    );
  }

  if (data === undefined || data.length === 0) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }
  const benchmarks = data.map((item: any) => item.name).sort();

  function handleBenchmarkChange(e: SelectChangeEvent<string>) {
    const b: string = e.target.value;
    setBenchmarkName(b);
  }

  return (
    <>
      <div>
        <FormControl>
          <InputLabel id={`benchmark-picker-input-label-${benchmarkName}`}>
            Benchmark
          </InputLabel>
          <Select
            value={benchmarkName}
            label="BenchmarkName"
            labelId={`benchmark-picker-select-label-${benchmarkName}`}
            onChange={handleBenchmarkChange}
            id={`benchmark-picker-select-${benchmarkName}`}
          >
            {benchmarks.map((b: string) => (
              <MenuItem key={`${b}`} value={b}>
                {b}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </div>
    </>
  );
}
