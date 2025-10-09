import TextField from "@mui/material/TextField";
import { useEffect, useState } from "react";

type MaxSamplingInputProps = {
  value: number;
  onChange: (n: number) => void;
  min?: number;     // default 2 (so first+last still make sense)
  max?: number;     // default 500
  label?: string;   // default "Max sampling"
  enableInput?: boolean; // default false
};

const styles = {
 root:{
    px:0, mx:0, minWidth: 100,
        "& .MuiOutlinedInput-root": {
          height: 28, // compact overall height
          "& input": {
            padding: "2px 8px", // tight inner padding
            fontSize: 12,
            lineHeight: 1.2,
          },
        },
        "& .MuiFormHelperText-root": { display: "none" }, // no helperText space
      }
    }

export function MaxSamplingInput({
  value,
  onChange,
  min = 5,
  max = 500,
  label = "Max data sampling",
  enableInput = false,
}: MaxSamplingInputProps) {
  // raw from user input
  const [raw, setRaw] = useState<string>(String(value));
  const [error, setError] = useState<string>("");
  const  [enable, setEnable] = useState<boolean>(enableInput);

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
    if (clamped !== n){
        setError(`Must be between ${min} and ${max}`);
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
      helperText={error || " "}
    />
  );
}
