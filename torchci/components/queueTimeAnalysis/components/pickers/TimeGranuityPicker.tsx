import { FormControl, InputLabel, MenuItem, Select } from "@mui/material";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import { InputLabelSx } from "./Shared";

export function TimeGranuityPicker({
  granularity,
  setGranularity,
  sx,
}: {
  granularity: any;
  sx?: any;
  setGranularity: (granularity: any) => void;
}) {
  return (
    <FormControl style={{ marginLeft: 10, minWidth: 100 }}>
      <InputLabel id="granularity-select-label" sx={InputLabelSx}>
        Granularity
      </InputLabel>
      <Select
        value={granularity}
        label="Granularity"
        labelId="granularity-select-label"
        onChange={(e) => setGranularity(e.target.value as Granularity)}
        MenuProps={{
          disableScrollLock: true,
        }}
        sx={sx}
      >
        <MenuItem sx={sx} value={"half_hour"}>
          Half Hour
        </MenuItem>
        <MenuItem sx={sx} value={"hour"}>
          Hour
        </MenuItem>
        <MenuItem sx={sx} value={"day"}>
          Daily
        </MenuItem>
        <MenuItem sx={sx} value={"week"}>
          Weekly
        </MenuItem>
        <MenuItem sx={sx} value={"month"}>
          Monthly
        </MenuItem>
      </Select>
    </FormControl>
  );
}
