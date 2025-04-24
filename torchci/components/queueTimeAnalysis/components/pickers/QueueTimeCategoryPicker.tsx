import {
  FormControl,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  useTheme,
} from "@mui/material";
import { InputLabelSx } from "./Shared";

export default function QueueTimeCategoryPicker({
  setCategory,
  category,
  sx,
}: {
  setCategory: any;
  category: string;
  sx?: any;
}) {
  const theme = useTheme();
  const handleChange = (event: SelectChangeEvent) => {
    setCategory(event.target.value);
  };
  return (
    <FormControl>
      <InputLabel id="category-picker-label" sx={InputLabelSx}>
        Search Category
      </InputLabel>
      <Select
        labelId="category-picker-select"
        id="category-picker-select"
        value={category}
        label="Category"
        onChange={handleChange}
        sx={sx}
        MenuProps={{
          disableScrollLock: true,
          PaperProps: {
            fontSize: "0.85rem", // this affects all dropdown options
          },
        }}
      >
        <MenuItem sx={sx} value={"workflow_name"}>
          workflow name
        </MenuItem>
        <MenuItem sx={sx} value={"job_name"}>
          job name
        </MenuItem>
        <MenuItem sx={sx} value={"machine_type"}>
          machine type
        </MenuItem>
      </Select>
      <FormHelperText>
        {" "}
        By default, shows data for all queued jobs. Using filter and checkbox
        below for specifc items
      </FormHelperText>
    </FormControl>
  );
}
