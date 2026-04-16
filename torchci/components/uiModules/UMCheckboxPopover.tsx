import {
  Box,
  Checkbox,
  FormControlLabel,
  Popover,
  SxProps,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { UMDenseButton } from "./UMDenseComponents";

type DenseCheckboxPopoverProps = {
  options: string[];
  onChange: (selected: string[]) => void;
  sx?: SxProps;
  buttonLabel?: string;
};

export function UMCheckboxPopover({
  options,
  onChange,
  sx,
  buttonLabel = "Select Items",
}: DenseCheckboxPopoverProps) {
  const [selected, setSelected] = useState<string[]>([...options]);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  const updateSelected = (newSelected: string[]) => {
    setSelected(newSelected);
    const unselected = options.filter((opt) => !newSelected.includes(opt));
    onChange(unselected);
  };

  useEffect(() => {
    setSelected([...options]);
  }, [options]);

  const handleToggle = (option: string) => {
    const updated = selected.includes(option)
      ? selected.filter((v) => v !== option)
      : [...selected, option];
    updateSelected(updated);
  };

  const handleSelectAll = () => {
    setSelected([...options]);
    onChange([]);
  };

  const handleClearAll = () => {
    setSelected([]);
    onChange([...options]);
  };

  return (
    <>
      <UMDenseButton
        variant="outlined"
        size="small"
        onClick={(e) => setAnchorEl(e.currentTarget)}
        sx={{ fontSize: "0.75rem", px: 0.5 }}
      >
        {buttonLabel}
      </UMDenseButton>
      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        <Typography fontWeight={500} fontSize="0.75rem" mb={0.5}>
          Options
        </Typography>

        <Box display="flex" flexDirection="column" gap={0.1}>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                sx={{ p: 0.25 }}
                checked={selected.length === options.length}
                indeterminate={
                  selected.length > 0 && selected.length < options.length
                }
                onChange={(e) =>
                  e.target.checked ? handleSelectAll() : handleClearAll()
                }
              />
            }
            label="Select All"
            sx={{ ".MuiFormControlLabel-label": { fontSize: "0.75rem" }, m: 0 }}
          />

          {options.map((option) => (
            <FormControlLabel
              key={option}
              control={
                <Checkbox
                  size="small"
                  sx={{ p: 0.25, padding: "0 10px" }}
                  checked={selected.includes(option)}
                  onChange={() => handleToggle(option)}
                />
              }
              label={option}
              sx={{
                ".MuiFormControlLabel-label": { fontSize: "0.75rem" },
                m: 0,
              }}
            />
          ))}
        </Box>
      </Popover>
    </>
  );
}
function setSelected(arg0: string[]) {
  throw new Error("Function not implemented.");
}
