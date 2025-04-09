import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
} from "@mui/material";

export function RepositoryPicker({
  repository,
  setRepository,
}: {
  repository: string;
  setRepository: any;
}) {
  function handleChange(e: SelectChangeEvent<string>) {
    setRepository(e.target.value);
  }
  return (
    <FormControl>
      <InputLabel id="repository-select-label">Granularity</InputLabel>
      <Select
        value={repository}
        label="Repo"
        labelId="repository-select-label"
        onChange={handleChange}
      >
        <MenuItem value={"hour"}>hour</MenuItem>
        <MenuItem value={"day"}>day</MenuItem>
        <MenuItem value={"week"}>week</MenuItem>
        <MenuItem value={"month"}>month</MenuItem>
      </Select>
    </FormControl>
  );
}
