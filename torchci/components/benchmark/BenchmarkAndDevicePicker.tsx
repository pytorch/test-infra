import {
    FormControl,
    InputLabel,
    MenuItem,
    Select,
    SelectChangeEvent,
    Skeleton,
} from "@mui/material";
  
import dayjs from "dayjs";
import { fetcher } from "lib/GeneralUtils";
import { useEffect } from "react";
import useSWR from "swr";


export function BenchmarkAndDevicePicker({
    queryName,
    queryParams,
    benchmarkName,
    setBenchmarkName,
    deviceName,
    setDeviceName,
    timeRange,
  }: {
    queryName: string;
    queryParams: { [k: string]: any };
    benchmarkName: string;
    setBenchmarkName: any;
    deviceName: string;
    setDeviceName: any;
    timeRange: any;
  }) {
    const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
        JSON.stringify(queryParams)
    )}`;
    
    let { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
    });
  }