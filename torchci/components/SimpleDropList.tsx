import {
  FormControl,
  MenuItem,
  Select,
  SelectChangeEvent,
} from "@mui/material";
import { useEffect, useState } from "react";

export default function SimpleDropList({
  onChange,
  defaultValue,
  options,
}: {
  onChange: (value: string) => void;
  defaultValue?: string;
  options: { value: string; name: string }[];
}) {
  const [value, setValue] = useState<string>("");

  useEffect(() => {
    if (defaultValue) {
      setValue(defaultValue);
    } else {
      setValue("unkown");
    }
  }, [defaultValue]);

  const handleChange = (event: SelectChangeEvent) => {
    setValue(event.target.value);
    onChange(event.target.value);
  };
  return (
    <div>
      <FormControl sx={{ m: 1, minWidth: 80 }}>
        <Select value={value} onChange={handleChange} autoWidth>
          {defaultValue == undefined ? (
            <MenuItem value="unkown"></MenuItem>
          ) : null}
          {options.map((option, idx) => {
            return (
              <MenuItem key={idx} value={option.value}>
                {option.name}
              </MenuItem>
            );
          })}
        </Select>
      </FormControl>
    </div>
  );
}
