import {
    FormControl,
    InputLabel,
    MenuItem,
    Select,
    SelectChangeEvent,
  } from "@mui/material";
  
  export const DEFAULT_JOB = "inductor";

  export const JOBS: { [k: string]: string } = {
    inductor: "TorchInductor",
    torchao: "TorchAO",
  };
  
  export function JobPicker({
    job,
    setJob,
  }: {
    job: string;
    setJob: any;
  }) {
    function handleChange(e: SelectChangeEvent<string>) {
      setJob(e.target.value);
    }
  
    return (
      <>
        <FormControl>
          <InputLabel id="job-picker-input-label">Job</InputLabel>
          <Select
            value={job}
            label="Job"
            labelId="job-picker-select-label"
            onChange={handleChange}
            id="job-picker-select"
          >
            {Object.keys(JOBS).map((job) => (
              <MenuItem key={job} value={job}>
                {JOBS[job]}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </>
    );
  }
  