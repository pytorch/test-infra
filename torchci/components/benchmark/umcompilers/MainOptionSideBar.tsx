// components/Sidebar.tsx
"use client";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { UMDateButtonPicker } from "components/uiModules/UMDateRangePicker";
import dayjs from "dayjs";
import { useDashboardStore } from "lib/benchmark/store/benchmark_dashboard_provider";
import { DISPLAY_NAMES_TO_DEVICE_NAMES, DTYPES_V2 } from "../compilers/common";
import { UMDenseDropdown, UMDenseModePicker } from "components/uiModules/UMDenseRenderers";

export function Sidebar() {
  const useStore = useDashboardStore();

  const stagedTime = useStore((s) => s.stagedTime);
  const stagedFilters = useStore((s) => s.stagedFilters);
  const setStagedTime = useStore((s) => s.setStagedTime);
  const committedTime = useStore((s) => s.committedTime);
  const committedFilters = useStore((s) => s.committedFilters);
  const commitMainOptions = useStore((s) => s.commitMainOptions);
  const revertMainOptions = useStore((s) => s.revertMainOptions);

  const dirty =
    stagedTime.start.valueOf() !== committedTime.start.valueOf() ||
    stagedTime.end.valueOf() !== committedTime.end.valueOf() ||
    JSON.stringify(stagedFilters) !== JSON.stringify(committedFilters);

  return (
    <Stack spacing={2}>
      <Typography variant="h6">Search</Typography>
      <UMDateButtonPicker
        setTimeRange={(start: dayjs.Dayjs, end: dayjs.Dayjs) =>
          setStagedTime({ start, end })
        }
        start={stagedTime.start}
        end={stagedTime.end}
      />
      <Divider />
      {/* Dropdown filters */}
      <Typography variant="subtitle2">Filters</Typography>
      <Stack spacing={1.5}>
        <Dropdowns />
      </Stack>
      <Divider />
      {/* Apply / Revert */}
      <Stack direction="row" spacing={1}>
        <Button
          variant="outlined"
          disabled={!dirty}
          onClick={revertMainOptions}
        >
          Revert
        </Button>
        <Button
          variant="contained"
          disabled={!dirty}
          onClick={commitMainOptions}
        >
          Apply
        </Button>
      </Stack>
    </Stack>
  );
}

export function Dropdowns() {
  const useStore = useDashboardStore();
  const stagedFilters = useStore((s) => s.stagedFilters);
  const setStagedFilter = useStore((s) => s.setStagedFilter);

  return (
    <>
      <UMDenseModePicker
        mode={stagedFilters.mode ?? ""}
        setMode={(val: string) => setStagedFilter("mode", val)}
        setDType={(val: string) => setStagedFilter("dtype", val)}
      />
      <UMDenseDropdown
        dtype={stagedFilters.dtype ?? ""}
        setDType={(val: string) =>
          val === "notset"
            ? setStagedFilter("dtype", "")
            : setStagedFilter("dtype", val)
        }
        dtypes={DTYPES_V2}
        label="Precision"
      />
      <UMDenseDropdown
        dtype={stagedFilters.deviceName ?? ""}
        setDType={(val: string) => setStagedFilter("deviceName", val)}
        dtypes={Object.keys(DISPLAY_NAMES_TO_DEVICE_NAMES)}
        label="Device"
      />
    </>
  );
}
