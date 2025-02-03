import {
  FormControl,
  MenuItem,
  Select,
  SelectChangeEvent,
} from "@mui/material";
import { useState } from "react";

export default function DropList({
  onChange,
  options,
}: {
  onChange: (value: string) => void;
  options: { value: string; name: string }[];
}) {
  const [value, setValue] = useState<string>("unselect");

  const handleChange = (event: SelectChangeEvent) => {
    setValue(event.target.value);
    onChange(event.target.value);
  };
  return (
    <div>
      <FormControl sx={{ m: 1, minWidth: 80 }}>
        <Select value={value} onChange={handleChange} autoWidth>
          <MenuItem value={"unselect"}>{"unselect"}</MenuItem>
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
