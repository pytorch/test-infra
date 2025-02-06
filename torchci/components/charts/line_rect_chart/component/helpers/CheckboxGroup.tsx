import { Box, Checkbox, FormControlLabel } from "@mui/material";
import React, { useEffect, useState } from "react";

export interface CheckboxItem {
  name: string;
  id?: string;
  checked: boolean;
}

export default function CheckboxGroup({
  parentName,
  childGroup,
  onChange,
}: {
  parentName: string;
  childGroup: CheckboxItem[];
  onChange: (checked: CheckboxItem[]) => void;
}) {
  const [checkedChild, setCheckedChild] = useState<CheckboxItem[]>([]);

  useEffect(() => {
    setCheckedChild(childGroup);
  }, [childGroup]);

  const handleChildChange = (
    event: React.ChangeEvent<HTMLInputElement>,
    idx: number
  ) => {
    const newCheckedChild = [...checkedChild];
    newCheckedChild[idx].checked = event.target.checked;
    setCheckedChild(newCheckedChild);
    onChange(newCheckedChild);
  };

  const handleParentChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newCheckedChild = [...checkedChild];
    newCheckedChild.forEach((child) => {
      child.checked = event.target.checked;
    });
    setCheckedChild(newCheckedChild);
    onChange(newCheckedChild);
  };

  if (!childGroup || childGroup.length === 0) {
    return <div></div>;
  }

  const isAllChildChecked = () => {
    const res = checkedChild.every((child) => child.checked);
    return res;
  };

  const isSomeChildChecked = () => {
    const res = checkedChild.some((child) => child.checked);
    return res;
  };

  if (!parentName || checkedChild.length === 0) {
    return <div></div>;
  }

  return (
    <Box>
      <FormControlLabel
        label={parentName}
        control={
          <Checkbox
            checked={isAllChildChecked()}
            indeterminate={isSomeChildChecked() && !isAllChildChecked()}
            onChange={handleParentChange}
          />
        }
      />
      <Box sx={{ display: "flex", flexDirection: "column", ml: 3 }}>
        {checkedChild.length > 0 &&
          checkedChild.map((child, idx) => {
            return (
              <FormControlLabel
                key={child.id}
                label={child.name}
                control={
                  <Checkbox
                    checked={checkedChild[idx].checked}
                    onChange={(evt) => handleChildChange(evt, idx)}
                  />
                }
              />
            );
          })}
      </Box>
    </Box>
  );
}
