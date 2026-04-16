import { ToggleButton, ToggleButtonGroup } from "@mui/material";
import React, { useEffect } from "react";

interface ToggleGroupProps {
  defaultValue: string;
  items: ToggleButtonItem[];
  onChange?: (value: string) => void;
}

interface ToggleButtonItem {
  name: string;
  value: string;
}

export const ToggleGroup = ({
  defaultValue,
  items,
  onChange = () => {},
}: ToggleGroupProps) => {
  const [alignment, setAlignment] = React.useState("");

  const handleChange = (
    event: React.MouseEvent<HTMLElement>,
    newAlignment: string
  ) => {
    setAlignment(newAlignment);
    onChange(newAlignment);
  };

  useEffect(() => {
    if (defaultValue) {
      setAlignment(defaultValue);
    } else {
      setAlignment("none");
    }
  }, [defaultValue, items]);

  return (
    <ToggleButtonGroup
      color="primary"
      value={alignment}
      exclusive
      onChange={handleChange}
      aria-label="Platform"
    >
      {!defaultValue && <ToggleButton value="none">None</ToggleButton>}
      {items.map((item) => {
        return (
          <ToggleButton key={item.name} value={item.value}>
            {item.name}
          </ToggleButton>
        );
      })}
    </ToggleButtonGroup>
  );
};
