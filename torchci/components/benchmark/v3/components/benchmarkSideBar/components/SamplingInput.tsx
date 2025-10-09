import DoneIcon from "@mui/icons-material/Done";
import { IconButton } from "@mui/material";
import TextField from "@mui/material/TextField";
import { Stack } from "@mui/system";
import { MIN_SAMPLING_THRESHOLD } from "components/benchmark/v3/configs/utils/dataBindingRegistration";
import { useEffect, useState } from "react";

type MaxSamplingInputProps = {
  value: number;
  onChange: (n: number) => void;
  min?: number; // default 2 (so first+last still make sense)
  max?: number; // default 500
  label?: string; // default "Max sampling"
  enableInput?: boolean; // default false
  info?: string;
};

const styles = {
  root: {
    px: 0,
    mx: 0,
    minWidth: 100,
    "& .MuiOutlinedInput-root": {
      height: 28, // compact overall height
      "& input": {
        padding: "2px 8px", // tight inner padding
        fontSize: 12,
        lineHeight: 1.2,
      },
    },
  },
};

export function MaxSamplingInput({
  value,
  onChange,
  min = MIN_SAMPLING_THRESHOLD,
  max = 50000,
  label = "Max sampling",
  info = "Max benchmark results to return. Use lower values to avoid OOM issues",
}: MaxSamplingInputProps) {
  // raw from user input
  const [raw, setRaw] = useState<string>(String(value));
  const original = value;
  const [error, setError] = useState<string>("");

  useEffect(() => {
    setRaw(String(value));
  }, [value]);

  const commit = () => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      setError("Enter an integer");
      return;
    }
    const clamped = Math.max(min, Math.min(max, n));
    setError(clamped !== n ? `Must be between ${min} and ${max}` : "");
    if (clamped !== n) {
      setError(`Must be between ${min} and ${max}`);
      setRaw(String(original));
      return;
    }
    onChange(clamped);
  };

  const onKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
      commit();
    }
  };
  return (
    <Stack direction="row" spacing={1} alignItems="flex-start" flexGrow={1}>
      <TextField
        size="small"
        label={label}
        value={raw}
        sx={styles.root}
        onChange={(e) => {
          setRaw(e.target.value);
          setError("");
        }}
        onBlur={commit}
        onKeyDown={onKeyDown}
        error={!!error}
        helperText={error || info}
      />
      <IconButton
        color="primary"
        size="small"
        onClick={commit}
        disabled={raw === String(original) || !!error}
        aria-label="confirm label"
      >
        <DoneIcon />
      </IconButton>
    </Stack>
  );
}
