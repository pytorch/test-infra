import {
  Button,
  ButtonProps,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Typography,
  type SelectChangeEvent,
} from "@mui/material";
import { Box, Stack } from "@mui/system";
import styled from "@mui/system/styled";
import React from "react";

export const UMDenseButton = styled(Button)(({ theme }) => ({
  padding: "2px 2px",
  minHeight: "20px",
  fontSize: "0.75rem",
  color: "grey",
  minWidth: "auto",
  borderRadius: 0,
  textTransform: "none", // optional: avoids uppercase
}));

export const UMDenseButtonLight = styled(Button)(({ theme }) => ({
  padding: "2px 4px",
  minHeight: "25px",
  fontSize: "0.75rem",
  borderRadius: 4,
  textTransform: "none", // optional: avoids uppercase
}));

export const UMDenseSingleButton = styled(Button)<ButtonProps>(({ theme }) => ({
  px: 0.5,
  py: 0,
  mx: 1,
  minWidth: "auto",
  lineHeight: 2,
  fontSize: "0.75rem",
  textTransform: "none",
}));

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
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    m: 0.2,
  },
  // smaller text + tight line height
  "& .MuiTypography-root": {
    fontSize: "0.95rem",
    lineHeight: 1.0,
  },
};

// Optional: compact display for the Select trigger itself
const DENSE_SELECT_SX = {
  "& .MuiSelect-select": {
    minHeight: 20,
    paddingTop: 0.5,
    paddingBottom: 0.5,
    fontSize: "0.9rem",
    m: 0.5,
  },
};

type Props = {
  dtype: string;
  setDType: (v: string) => void;
  dtypes: (string | UMDenseDropdownOption)[];
  label: string;
  disable?: boolean;
};

export const DEFAULT_MODE = "inference";
// The value is the default dtype for that mode
export const MODES: { [k: string]: string } = {
  training: "amp",
  inference: "bfloat16",
};

export interface UMDenseDropdownOption {
  value: string;
  displayName?: string;
}

export const UMDenseDropdown: React.FC<Props> = ({
  dtype,
  setDType,
  dtypes,
  label,
  disable = false,
}) => {
  const labelId = "dtype-picker-label";
  const selectId = "dtype-picker-select";
  const handleChange = (e: SelectChangeEvent<string>) => {
    setDType(e.target.value);
  };

  const safeValue = dtype ?? "";
  return (
    <FormControl size="small">
      <InputLabel id={labelId} shrink>
        {label}
      </InputLabel>
      <Select
        id={selectId}
        labelId={labelId} // make sure these match
        value={safeValue}
        label={label}
        onChange={handleChange}
        sx={DENSE_SELECT_SX} // dense trigger
        MenuProps={{
          PaperProps: { sx: DENSE_MENU_STYLE },
        }}
        displayEmpty
        disabled={disable}
      >
        {dtypes.map((item) => {
          const option =
            typeof item === "string"
              ? { value: item, displayName: item }
              : item;
          return (
            <MenuItem key={option.value} value={option.value}>
              <Typography variant="body2">
                {option.displayName ?? option.value}
              </Typography>
            </MenuItem>
          );
        })}
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
              <Typography variant="body2">{mode}</Typography>
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

export const UMDenseCommitDropdown: React.FC<{
  label: string;
  disable: boolean;
  branchName: string;
  commitList: UMDenseCommitDropdownCommitData[];
  selectedCommit: UMDenseCommitDropdownCommitData | null;
  setCommit: (c: UMDenseCommitDropdownCommitData | null) => void;
}> = ({ label, disable, commitList, selectedCommit, setCommit }) => {
  // Clamp the value so we never feed an out-of-range value to Select
  const selectedValue =
    selectedCommit?.workflow_id &&
    commitList.some((c) => c.workflow_id === selectedCommit.workflow_id)
      ? selectedCommit.workflow_id
      : "";

  function handleChange(e: SelectChangeEvent<string>) {
    const wf = e.target.value as string;
    setCommit(commitList.find((c) => c.workflow_id === wf) ?? null);
  }

  return (
    <Stack direction="row" spacing={1} sx={{ width: "100%" }}>
      {/* branchName field ... (unchanged) */}
      <FormControl
        size="small"
        fullWidth
        disabled={disable || commitList.length === 0}
      >
        <InputLabel id={`lbl-${label.toLowerCase()}`}>{label}</InputLabel>
        <Select
          size="small"
          labelId={`lbl-${label.toLowerCase()}`}
          label={label}
          value={selectedValue}
          onChange={handleChange}
          MenuProps={{ PaperProps: { sx: DENSE_MENU_STYLE } }}
        >
          {commitList.map((c) => (
            <MenuItem key={c.workflow_id} value={c.workflow_id}>
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
