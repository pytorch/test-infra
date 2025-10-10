import DoneIcon from "@mui/icons-material/Done";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import {
  Chip,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { Box } from "@mui/system";
import { useEffect, useState } from "react";

export interface SingleLabelInputProps {
  title?: string;
  value: string;
  onChange?: (newLabel?: string) => void;
  helperText?: string;
  info?: string;
}
const styles = {
  root: {
    px: 0,
    mx: 0,
    minWidth: 100,
    "& .MuiOutlinedInput-root": {
      height: 30, // compact height
      "& input": {
        padding: "2px 8px",
        fontSize: 12,
        lineHeight: 1.2,
      },
    },
    "& .MuiInputLabel-root": {
      fontSize: 12,
      lineHeight: 1.2,
      top: "2px", // small downward offset
      transform: "translate(10px, 6px) scale(1)",
      "&.MuiInputLabel-shrink": {
        top: 0,
        transform: "translate(20px, -6px) scale(0.8)", // floats up correctly
      },
    },
  },
  chip: {
    height: "auto", // allow wrapping
    px: 1,
    py: 0.5,
    whiteSpace: "normal", // enable wrapping
    alignItems: "flex-start", // top align label when multi-line
    "& .MuiChip-label": {
      display: "block", // allow line breaks
      whiteSpace: "normal",
      wordBreak: "break-word",
      padding: 0,
    },
    "& .MuiChip-deleteIcon": {
      marginLeft: 0.5,
      alignSelf: "center", // keep delete icon centered vertically
    },
  },
};

export function SingleStringLabelInput({
  title = "Label",
  value = "",
  helperText = "",
  info = "",
  onChange,
}: SingleLabelInputProps) {
  const [inputValue, setInputValue] = useState(value ?? "");
  const [label, setLabel] = useState(value ?? "");

  const handleConfirm = () => {
    if (inputValue.trim()) {
      const newLabel = inputValue.trim();
      setLabel(newLabel);
      setInputValue("");
      onChange?.(newLabel);
    }
  };

  const handleDelete = () => {
    setLabel("");
    setInputValue("");
    onChange?.("");
  };

  useEffect(() => {
    if (value === label) return;
    if (!value) {
      setLabel("");
      setInputValue("");
      return;
    }
    setInputValue(value);
    setLabel(value);
  }, [value]);

  const infoTooltip = () => {
    return (
      <Tooltip title={info} arrow>
        <InfoOutlinedIcon
          fontSize="small"
          color="action"
          sx={{
            opacity: 0.7,
            cursor: "pointer",
            "&:hover": { opacity: 1 },
          }}
        />
      </Tooltip>
    );
  };

  return (
    <Box>
      {/* Input area */}
      <Stack direction="row" spacing={1} alignItems="flex-start">
        {label ? (
          <>
            {info && infoTooltip()}
            <Typography variant="body2" sx={{ fontSize: "0.875rem" }}>
              {title}:
            </Typography>
            <Chip
              label={
                <Stack direction="row" alignItems="center" spacing={0.5}>
                  {label}
                </Stack>
              }
              onDelete={handleDelete}
              color="primary"
              sx={styles.chip}
            />
          </>
        ) : (
          <Stack
            direction="row"
            spacing={1}
            alignItems="flex-start"
            flexGrow={1}
          >
            {info && infoTooltip()}
            <TextField
              fullWidth
              sx={styles.root}
              label={title}
              variant="outlined"
              size="small"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleConfirm()}
              helperText={helperText}
            />
            <IconButton
              color="primary"
              size="small"
              onClick={handleConfirm}
              disabled={!inputValue.trim()}
              aria-label="confirm label"
            >
              <DoneIcon />
            </IconButton>
          </Stack>
        )}
      </Stack>
    </Box>
  );
}
