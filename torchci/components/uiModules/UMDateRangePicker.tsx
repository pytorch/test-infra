import { Box, Popover, Stack } from "@mui/material";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import dayjs, { Dayjs } from "dayjs";
import * as React from "react";
import { UMDenseButton } from "./UMDenseComponents";
import { UMDenseDatePicker } from "./UMDenseDatePicker";

const presets = [
  { key: "today", label: "Today", days: 1 },
  { key: "last2", label: "Last 2 Days", days: 2 },
  { key: "last3", label: "Last 3 Days", days: 3 },
  { key: "last7", label: "Last 7 Days", days: 7 },
  { key: "last10", label: "Last 10 Days", days: 10 },
  { key: "last14", label: "Last 14 Days", days: 14 },
  { key: "last30", label: "Last 30 Days", days: 30 },
];

interface PresetDateRangeSelectorProps {
  setTimeRange?: (startDate: Dayjs, endDate: Dayjs) => void;
  start?: dayjs.Dayjs;
  end?: dayjs.Dayjs;
  gap?: number;
}

export function UMDateRangePicker({
  start = dayjs().utc().startOf("day").subtract(6, "day"),
  end = dayjs().utc().endOf("day"),
  gap = 1,
  setTimeRange = () => {},
}: PresetDateRangeSelectorProps) {
  const [startDate, setStartDate] = React.useState<Dayjs>(dayjs.utc(start));
  const [endDate, setEndDate] = React.useState<Dayjs>(dayjs.utc(end));
  const [activePreset, setActivePreset] = React.useState<string | null>("");

  const setRange = (days: number, key: string) => {
    const now = dayjs().utc().startOf("hour");
    const start = now.startOf("day").subtract(days - gap, "day");
    setStartDate(start);
    setEndDate(now);
    setActivePreset(key);
    setTimeRange(start, now);
  };

  const handleManualStart = (newValue: any) => {
    if (newValue) {
      const newStart = dayjs.utc(newValue).startOf("day");
      setStartDate(newStart);
      setActivePreset(null);
      setTimeRange(newValue, endDate);
    }
  };

  const handleManualEnd = (newValue: any) => {
    if (newValue) {
      let newEnd = dayjs.utc(newValue).endOf("day");
      setEndDate(newEnd);
      setActivePreset(null);
      setTimeRange(startDate, newEnd);
    }
  };

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Stack spacing={2} sx={{ margin: "10px 0px" }}>
        {/* Preset Buttons */}
        <Stack direction="row" spacing={1}>
          {presets.map(({ key, label, days }) => (
            <UMDenseButton
              key={key}
              variant={activePreset === key ? "contained" : "outlined"}
              onClick={() => setRange(days, key)}
            >
              {label}
            </UMDenseButton>
          ))}
        </Stack>
        {/* Manual Pickers */}
        <Box sx={{ display: "flex", gap: 2 }}>
          <UMDenseDatePicker
            label="Start Date"
            value={startDate}
            onChange={handleManualStart}
          />
          <UMDenseDatePicker
            label="End Date"
            value={endDate}
            onChange={handleManualEnd}
          />
        </Box>
      </Stack>
    </LocalizationProvider>
  );
}

export function UMDateButtonPicker({
  start = dayjs().utc().startOf("day").subtract(6, "day"),
  end = dayjs().utc().endOf("day"),
  setTimeRange = () => {},
}: PresetDateRangeSelectorProps) {
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef(null);

  return (
    <div>
      <Box
        sx={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
        }}
      >
        <Box sx={{ margin: "0 2px 0 0", fontSize: "0.8rem" }}>Time Range:</Box>
        <UMDenseButton
          ref={anchorRef}
          variant="outlined"
          onClick={() => setOpen(true)}
          sx={{
            margin: "5px 0px",
            borderRadius: 0,
            textTransform: "none",
            minWidth: 160,
            justifyContent: "space-between",
          }}
        >
          {start.format("YYYY-MM-DD")} - {end.format("YYYY-MM-DD")}
        </UMDenseButton>
      </Box>
      <Popover
        open={open}
        anchorEl={anchorRef.current}
        onClose={() => setOpen(false)}
        anchorOrigin={{
          vertical: "bottom",
          horizontal: "left",
        }}
        sx={{
          padding: "10px 0px",
          minWidth: 260,
        }}
      >
        <Box p={2}>
          <UMDateRangePicker
            start={start}
            end={end}
            setTimeRange={setTimeRange}
          />
        </Box>
      </Popover>
    </div>
  );
}
