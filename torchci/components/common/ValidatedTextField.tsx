import { TextField } from "@mui/material";
import { useState } from "react";

// Text field but with validation
export function ValidatedTextField({
  name,
  isValid,
  initialValue,
  errorMessage = "Invalid",
}: {
  name: string;
  isValid: (value: string) => boolean;
  initialValue: string;
  errorMessage?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const [valid, setValid] = useState(true);
  function onChangeWrapper(e: React.ChangeEvent<HTMLInputElement>) {
    const newValue = e.target.value;
    setValue(newValue);
    setValid(isValid(newValue));
  }

  return (
    <TextField
      label={name}
      value={value}
      onChange={onChangeWrapper}
      error={!valid}
      helperText={!valid ? errorMessage : ""}
      name={name}
    />
  );
}
