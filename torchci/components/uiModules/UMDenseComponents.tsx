import { Button, TextField } from "@mui/material";
import styled from "@mui/system/styled";

export const UMDenseButton = styled(Button)(({ theme }) => ({
  padding: "2px 2px",
  minHeight: "20px",
  fontSize: "0.75rem",
  color: "grey",
  minWidth: "auto",
  borderRadius: 0,
  textTransform: "none", // optional: avoids uppercase
}));

import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Typography,
  type SelectChangeEvent,
} from "@mui/material";
import { Box, Stack } from "@mui/system";
import React from "react";

// Reusable dense menu style (affects the dropdown list items)
export const DENSE_MENU_STYLE = {
  // shrink the whole list
  "& .MuiList-root": {
    paddingTop: 0,
    paddingBottom: 0,
  },
  // make each item short & tight
  "& .MuiMenuItem-root": {
    minHeight: 18, // default ~48
    paddingTop: 1, // 2px
    paddingBottom: 0,
    paddingLeft: 8,
    paddingRight: 8,
  },
  // smaller text + tight line height
  "& .MuiTypography-root": {
    fontSize: 12,
    lineHeight: 1.2,
  },
};

// Optional: compact display for the Select trigger itself
const DENSE_SELECT_SX = {
  "& .MuiSelect-select": {
    minHeight: 24,
    paddingTop: 0.25,
    paddingBottom: 0.25,
    fontSize: "0.75rem",
  },
};

type Props = {
  dtype: string;
  setDType: (v: string) => void;
  dtypes: string[];
  label: string;
};

export const DEFAULT_MODE = "inference";
// The value is the default dtype for that mode
export const MODES: { [k: string]: string } = {
  training: "amp",
  inference: "bfloat16",
};

export const UMDenseDropdown: React.FC<Props> = ({
  dtype,
  setDType,
  dtypes,
  label,
}) => {
  const labelId = "dtype-picker-label";
  const selectId = "dtype-picker-select";

  const handleChange = (e: SelectChangeEvent<string>) => {
    setDType(e.target.value);
  };

  return (
    <FormControl size="small">
      <InputLabel id={labelId}>{label}</InputLabel>
      <Select
        id={selectId}
        labelId={labelId} // make sure these match
        value={dtype}
        label={label}
        onChange={handleChange}
        sx={DENSE_SELECT_SX} // dense trigger
        MenuProps={{
          PaperProps: { sx: DENSE_MENU_STYLE },
        }}
      >
        {dtypes.map((v) => (
          <MenuItem key={v} value={v}>
            {v}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
};

export function UMDenseModePicker({
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
          sx={DENSE_SELECT_SX} // dense trigger
          MenuProps={{
            PaperProps: { sx: DENSE_MENU_STYLE }, // dense list
          }}
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

export type UMDenseCommitDropdownCommitData = {
  commit: string;
  workflow_id: string;
  date: string;
  branch: string;
};

type UMDenseCommitDropdownProps = {
  label: string;
  disable: boolean;
  branchName: string; // show branch name only
  commitList: UMDenseCommitDropdownCommitData[];
  selectedCommit: UMDenseCommitDropdownCommitData | null;
  setCommit: (commit: UMDenseCommitDropdownCommitData | null) => void;
};

export const UMDenseCommitDropdown: React.FC<UMDenseCommitDropdownProps> = ({
  label,
  disable,
  branchName,
  commitList,
  selectedCommit,
  setCommit,
}) => {
  function handleChange(e: SelectChangeEvent<string>) {
    const val = e.target.value as string;
    setCommit(commitList.find((c) => c.commit === val) ?? null);
  }

  return (
    <Stack direction="row" spacing={1} sx={{ width: "100%" }}>
      {/* Left: branch name (read-only) */}
      <TextField
        label="Branch"
        size="small"
        value={branchName ?? ""}
        disabled={true}
        sx={{
          flex: 1,
          "& .MuiInputBase-input": {
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            overflow: "hidden",
          },
        }}
      />

      {/* Right: commit dropdown */}
      <FormControl
        size="small"
        fullWidth
        disabled={disable || commitList.length === 0}
        sx={{ flex: 1 }}
      >
        <InputLabel id={`lbl-${label.toLowerCase()}`}>{label}</InputLabel>
        <Select
          size="small"
          labelId={`lbl-${label.toLowerCase()}`}
          label={label}
          value={selectedCommit?.commit ?? ""}
          onChange={handleChange}
          MenuProps={{ PaperProps: { sx: DENSE_MENU_STYLE } }}
        >
          {commitList.map((c) => (
            <MenuItem key={c.commit} value={c.commit}>
              <Box display="flex" flexDirection="column">
                <Typography variant="body2">{c.commit.slice(0, 7)}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {c.workflow_id} • {c.date}
                </Typography>
              </Box>
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </Stack>
  );
};
