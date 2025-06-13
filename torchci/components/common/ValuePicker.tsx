import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
} from "@mui/material";

export default function ValuePicker({
  value,
  setValue,
  values,
  label,
}: {
  value: string;
  setValue: any;
  values: string[];
  label: string;
}) {
  function handleChange(e: SelectChangeEvent<string>) {
    setValue(e.target.value);
  }

  return (
    <>
      <FormControl>
        <InputLabel id="value-picker-input-label">{label}</InputLabel>
        <Select
          value={value}
          label={label}
          labelId={`value-picker-select-label-${label}`}
          onChange={handleChange}
          id={`value-picker-select-${label}`}
        >
          {values.map((value) => (
            <MenuItem key={value} value={value}>
              {value}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </>
  );
}
