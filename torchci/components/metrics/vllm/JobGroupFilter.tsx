/**
 * Job group filter component for vLLM metrics
 * Allows filtering jobs by AMD, Torch Nightly, or Main groups
 */

import {
  Box,
  Checkbox,
  Divider,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormLabel,
  Paper,
  Stack,
} from "@mui/material";

export type JobGroup = "amd" | "torch_nightly" | "main";

export interface JobGroupFilterProps {
  selectedGroups: JobGroup[];
  onChange: (groups: JobGroup[]) => void;
  timeRangePicker?: React.ReactNode;
}

export default function JobGroupFilter({
  selectedGroups,
  onChange,
  timeRangePicker,
}: JobGroupFilterProps) {
  const handleToggle = (group: JobGroup) => {
    const newGroups = selectedGroups.includes(group)
      ? selectedGroups.filter((g) => g !== group)
      : [...selectedGroups, group];
    onChange(newGroups);
  };

  return (
    <Paper sx={{ p: 2, width: "100%" }} elevation={3}>
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          gap: 3,
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Box sx={{ display: "flex", gap: 3, alignItems: "center" }}>
          <FormControl component="fieldset">
            <FormLabel component="legend" sx={{ fontWeight: "bold", mb: 1 }}>
              Job Groups
            </FormLabel>
            <FormGroup row>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={selectedGroups.includes("main")}
                    onChange={() => handleToggle("main")}
                  />
                }
                label="Main"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={selectedGroups.includes("amd")}
                    onChange={() => handleToggle("amd")}
                  />
                }
                label="AMD"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={selectedGroups.includes("torch_nightly")}
                    onChange={() => handleToggle("torch_nightly")}
                  />
                }
                label="Torch Nightly"
              />
            </FormGroup>
          </FormControl>
          {timeRangePicker && (
            <>
              <Divider 
                orientation="vertical" 
                flexItem 
                sx={{ 
                  borderRightWidth: 2, 
                  borderColor: 'text.secondary',
                }} 
              />
              <Box>{timeRangePicker}</Box>
            </>
          )}
        </Box>
      </Box>
    </Paper>
  );
}

