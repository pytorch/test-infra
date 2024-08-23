import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
} from "@mui/material";

export const SUITES: { [k: string]: string } = {
  torchbench: "Torchbench",
};

export function SuitePicker({
  suite,
  setSuite,
}: {
  suite: string;
  setSuite: any;
}) {
  function handleChange(e: SelectChangeEvent<string>) {
    setSuite(e.target.value);
  }

  return (
    <>
      <FormControl>
        <InputLabel id="suite-picker-input-label">Suite</InputLabel>
        <Select
          value={suite}
          label="Suite"
          labelId="suite-picker-select-label"
          onChange={handleChange}
          id="suite-picker-select"
        >
          {Object.keys(SUITES).map((suite) => (
            <MenuItem key={suite} value={suite}>
              {SUITES[suite]}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </>
  );
}
