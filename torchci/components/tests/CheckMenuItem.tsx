import { Checkbox, ListItemText, MenuItem } from "@mui/material";
import { forwardRef } from "react";

export interface CheckMenuItemProps {
  checked: boolean;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  // Set tight, as the headers' menus are.
  dense?: boolean;
  // Set in under a section row, so the values read as its own.
  indented?: boolean;
}

// A choice that can be on or off in a menu of several: an item with the
// checkbox role holding a small checkbox and the label. The title's
// multi-select menus and the headers' facet menus both render their rows
// with it, so the two kinds of menu stay alike. The ref reaches the item,
// for whoever needs to know where a section ends.
const CheckMenuItem = forwardRef<HTMLLIElement, CheckMenuItemProps>(
  function CheckMenuItem(
    {
      checked,
      label,
      onClick,
      disabled = false,
      dense = false,
      indented = false,
    },
    ref
  ) {
    return (
      <MenuItem
        ref={ref}
        role="menuitemcheckbox"
        aria-checked={checked}
        dense={dense}
        disabled={disabled}
        onClick={onClick}
        sx={indented ? { pl: 4 } : undefined}
      >
        <Checkbox
          size="small"
          checked={checked}
          tabIndex={-1}
          disableRipple
          sx={{ p: 0, mr: 1 }}
        />
        <ListItemText primary={label} />
      </MenuItem>
    );
  }
);

export default CheckMenuItem;
