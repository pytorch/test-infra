import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
} from "@mui/material";

export const DEFAULT_MODE = "training";
// The value is the default dtype for that mode
export const MODES: { [k: string]: string } = {
  training: "amp",
  inference: "bfloat16",
};
export const DTYPES = ["amp", "float16", "bfloat16", "quant"];

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
}: {
  dtype: string;
  setDType: any;
}) {
  function handleChange(e: SelectChangeEvent<string>) {
    setDType(e.target.value);
  }

  return (
    <>
      <FormControl>
        <InputLabel id="dtype-picker-input-label">Precision</InputLabel>
        <Select
          value={dtype}
          label="Precision"
          labelId="dtype-picker-select-label"
          onChange={handleChange}
          id="dtype-picker-select"
        >
          {DTYPES.map((dtype) => (
            <MenuItem key={dtype} value={dtype}>
              {dtype}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </>
  );
}
