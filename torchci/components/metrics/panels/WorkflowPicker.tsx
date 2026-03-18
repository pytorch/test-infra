import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
} from "@mui/material";

export const WORKFLOWS: { [k: string]: string } = {
  pull: "pull",
  trunk: "trunk",
  periodic: "periodic",
};

export default function WorkflowPicker({
  workflow,
  setWorkFlow,
}: {
  workflow: string;
  setWorkFlow: any;
}) {
  function handleChange(e: SelectChangeEvent<string>) {
    setWorkFlow(e.target.value);
  }

  return (
    <>
      <FormControl>
        <InputLabel id="workflow-picker-input-label">Workflow</InputLabel>
        <Select
          value={workflow}
          label="Workflow"
          labelId="workflow-picker-select-label"
          onChange={handleChange}
          id="workflow-picker-select"
        >
          {Object.keys(WORKFLOWS).map((workflow) => (
            <MenuItem key={workflow} value={workflow}>
              {WORKFLOWS[workflow]}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </>
  );
}
