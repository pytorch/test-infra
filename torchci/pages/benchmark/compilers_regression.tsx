import { Divider, Skeleton, Stack, Typography } from "@mui/material";
import utc from "dayjs/plugin/utc";
import {
  MAIN_BRANCH,
} from "components/benchmark/common";
import {
  DEFAULT_DEVICE_NAME,
  DISPLAY_NAMES_TO_ARCH_NAMES,
  DISPLAY_NAMES_TO_DEVICE_NAMES,
  DTYPES,
  DTYPES_V2,
  MODES_V2,
} from "components/benchmark/compilers/common";
import { SUITES } from "components/benchmark/compilers/SuitePicker";
import {
  DEFAULT_MODE,
  DTypePicker,
  ModePicker,
  MODES,
} from "components/benchmark/ModeAndDTypePicker";
import dayjs from "dayjs";
import { useRouter } from "next/router";
import { useEffect, useReducer, useState } from "react";
import { UMDateButtonPicker } from "components/uiModules/UMDateRangePicker";
import { UMPropReducer } from "components/uiModules/UMPropReducer";
import { useCompilerData } from "lib/benchmark/api_helper/compilers/type";
import LoadingPage from "components/common/LoadingPage";
dayjs.extend(utc);


export default function Page() {
  const initialDropdownFields = {
    mode: DEFAULT_MODE,
    dtype: MODES[DEFAULT_MODE],
    lBranch: MAIN_BRANCH,
    lCommit: "",
    rBranch: MAIN_BRANCH,
    rCommit: "",
    deviceName: DEFAULT_DEVICE_NAME,
    device: "cuda",
    arch: "h100"
  }

  const router = useRouter();

  const [timeRange, dispatchTimeRange] = useReducer(UMPropReducer, {
    start_time : dayjs.utc().startOf("day").subtract(7, "day"),
    end_time : dayjs.utc().endOf("day"),
  });
  const [dropdowns, dispatchDropdowns] = useReducer(UMPropReducer, initialDropdownFields);

  useEffect(() => {
    const {
      startTime,
      stopTime,
      mode,
      dtype,
      deviceName,
      lBranch,
      lCommit,
      rBranch,
      rCommit,
    } = router.query;

    if (startTime && stopTime) {
      // update time range
      dispatchTimeRange({
        type: "UPDATE_FIELDS",
        payload: {
          start_time: dayjs.utc(startTime as string),
          end_time: dayjs.utc(stopTime as string),
        },
      });
    }

  // collect dropdown updates only if they exist
  const newDropdowns = {
    ...dropdowns,
  };
  if (mode) newDropdowns.mode = mode as string;
  if (dtype) newDropdowns.dtype = dtype as string;
  if (deviceName) newDropdowns.deviceName = deviceName as string;
  if (lBranch) newDropdowns.lBranch = lBranch as string;
  if (lCommit) newDropdowns.lCommit = lCommit as string;
  if (rBranch) newDropdowns.rBranch = rBranch as string;
  if (rCommit) newDropdowns.rCommit = rCommit as string;

  if (Object.keys(newDropdowns).length > 0) {
    dispatchDropdowns({ type: "UPDATE_FIELDS", payload: newDropdowns });
  }
}, [router.query]);

  const granularity = "hour" // hardcoded for now

  const queryParams: { [key: string]: any } = {
    commits: [],
    branches:["main"],
    compilers: [],
    arch: DISPLAY_NAMES_TO_ARCH_NAMES[dropdowns.deviceName],
    device: DISPLAY_NAMES_TO_DEVICE_NAMES[dropdowns.deviceName],
    dtype: dropdowns.dtype,
    granularity: granularity,
    mode: dropdowns.mode,
    startTime: dayjs.utc(timeRange.start_time).format("YYYY-MM-DDTHH:mm:ss"),
    stopTime: dayjs.utc(timeRange.end_time).format("YYYY-MM-DDTHH:mm:ss"),
    suites: Object.keys(SUITES),
  };
  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          TorchInductor Performance DashBoard
        </Typography>
      </Stack>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <UMDateButtonPicker
          setTimeRange={(start: dayjs.Dayjs, end: dayjs.Dayjs) => {
            dispatchTimeRange({
              type: "UPDATE_FIELDS",
              payload: {
                start_time: start,
                end_time: end,
              },
            });
          }}
          start={timeRange.start_time}
          end={timeRange.end_time}
        />
        <Dropdowns
        dropdowns={dropdowns}
        dispatchDropdowns={dispatchDropdowns}
      />
      </Stack>
      <Divider />
      <br />
      <DataRender queryParams={queryParams} />
    </div>

  );
}

function DataRender(props: any) {
  const { data, isLoading, error } = useCompilerData("compiler_precompute",props.queryParams);
  if (isLoading) {
    return <LoadingPage />;
  }
  if (error) {
    return <div>Error: {error.message}</div>;
  }
  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}

type DropdownsProps = {
  dropdowns: any;
  dispatchDropdowns: React.Dispatch<any>;
};

function Dropdowns({
  dropdowns,
  dispatchDropdowns,
}: DropdownsProps) {

  const setDropdownField = (key: string, value: string) => {
    dispatchDropdowns({ type: "UPDATE_FIELDS", payload: { [key]: value } });
  };
  return (
    <>
      <ModePicker
        mode={dropdowns.mode}
        setMode={(val: string) => setDropdownField("mode", val)}
        setDType={(val: string) => setDropdownField("dtype", val)}
      />
      <DTypePicker
        dtype={dropdowns.dtype}
        setDType={(val: string) => {
          if (val === "notset"){
            setDropdownField("dtype", '')
          } else{
            setDropdownField("dtype", val)
          }
        }}
        dtypes={DTYPES_V2}
        label="Precision"
      />
      <DTypePicker
        dtype={dropdowns.deviceName}
        setDType={(val: string) => setDropdownField("deviceName", val)}
        dtypes={Object.keys(DISPLAY_NAMES_TO_DEVICE_NAMES)}
        label="Device"
      />
    </>
  );
}
