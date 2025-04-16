import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
} from "@mui/material";
import { DatePicker, LocalizationProvider } from "@mui/x-date-pickers";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import dayjs from "dayjs";

/**
 * Allows the user to pick from common time ranges, or manually set their own.
 */
export function DateRangePicker({
  startDate,
  setStartDate,
  stopDate,
  setStopDate,
  dateRange,
  setDateRange,
  setGranularity,
}: {
  startDate: dayjs.Dayjs;
  setStartDate: any;
  stopDate: dayjs.Dayjs;
  setStopDate: any;
  dateRange: any;
  setDateRange: any;
  setGranularity?: any;
}) {
  function handleChange(e: SelectChangeEvent<number>) {
    setDateRange(e.target.value as number);
    if (e.target.value !== -1) {
      const startDate = dayjs().subtract(e.target.value as number, "day");
      setStartDate(startDate);
      const stopDate = dayjs();
      setStopDate(stopDate);
    }

    if (setGranularity === undefined) {
      return;
    }

    // When setGranularity is provided, this picker can use it to switch to a
    // bigger granularity automatically when a longer time range is selected.
    // The users can still select a smaller granularity if they want to
    switch (e.target.value as number) {
      case 1:
      case 3:
        setGranularity("half_hour");
        break;
      case 7:
        setGranularity("hour");
        break;
      case 14:
        setGranularity("day");
        break;
      case 30:
      case 60:
        setGranularity("week");
        break;
      case 90:
      case 180:
      case 365:
        setGranularity("month");
        break;
    }
  }

  return (
    <>
      <FormControl>
        <InputLabel id="time-picker-select-label">Time Range</InputLabel>
        <Select
          value={dateRange}
          label="Time Range"
          labelId="time-picker-select-label"
          onChange={handleChange}
        >
          <MenuItem value={1}>Last 1 Day</MenuItem>
          <MenuItem value={3}>Last 3 Days</MenuItem>
          <MenuItem value={7}>Last 7 Days</MenuItem>
          <MenuItem value={14}>Last 14 Days</MenuItem>
          <MenuItem value={30}>Last Month</MenuItem>
          <MenuItem value={60}>Last 2 Months</MenuItem>
          <MenuItem value={90}>Last 3 Months</MenuItem>
          <MenuItem value={180}>Last 6 Months</MenuItem>
          <MenuItem value={365}>Last Year</MenuItem>
          <MenuItem value={-1}>Custom</MenuItem>
        </Select>
      </FormControl>
      {dateRange === -1 && (
        <>
          <CustomDatePicker
            label={"Start Date"}
            value={startDate}
            setValue={setStartDate}
          />
          <CustomDatePicker
            label={"End Date"}
            value={stopDate}
            setValue={setStopDate}
          />
        </>
      )}
    </>
  );
}

function CustomDatePicker({ label, value, setValue }: any) {
  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <DatePicker
        label={label}
        value={value}
        onChange={(newValue) => {
          setValue(newValue);
        }}
      />
    </LocalizationProvider>
  );
}
