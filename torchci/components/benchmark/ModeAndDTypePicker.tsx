import {
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  SelectChangeEvent,
} from "@mui/material";

export const DEFAULT_MODE = "training";
// The value is the default dtype for that mode
export const MODES: { [k: string]: string } = {
  training: "amp",
  inference: "bfloat16",
};

export function ModePicker({
  mode,
  setMode,
  setDType,
}: {
  mode: string;
  setMode: any;
  setDType: any;
}) {
  function handleChange(e: SelectChangeEvent<string>) {
    const selectedMode = e.target.value;
    setMode(selectedMode);
    setDType(selectedMode in MODES ? MODES[selectedMode] : "amp");
  }

  return (
    <>
      <FormControl>
        <InputLabel id="mode-picker-input-label">Mode</InputLabel>
        <Select
          value={mode}
          label="Mode"
          labelId="mode-picker-select-label"
          onChange={handleChange}
          id="mode-picker-select"
        >
          {Object.keys(MODES).map((mode) => (
            <MenuItem key={mode} value={mode}>
              {mode}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </>
  );
}

export function DTypePicker({
  dtype,
  setDType,
  dtypes,
  label,
}: {
  dtype: string;
  setDType: any;
  dtypes: string[];
  label: string;
}) {
  function handleChange(e: SelectChangeEvent<string>) {
    setDType(e.target.value);
  }

  return (
    <>
      <FormControl>
        <InputLabel id="dtype-picker-input-label">{label}</InputLabel>
        <Select
          value={dtype}
          label={label}
          labelId="dtype-picker-select-label"
          onChange={handleChange}
          id="dtype-picker-select"
        >
          {dtypes.map((dtype) => (
            <MenuItem key={dtype} value={dtype}>
              {dtype}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </>
  );
}
