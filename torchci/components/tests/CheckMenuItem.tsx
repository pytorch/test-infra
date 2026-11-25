import { Box, Checkbox, ListItemText, MenuItem } from "@mui/material";
import { forwardRef, ReactNode, useState } from "react";

export interface CheckMenuItemProps {
  checked: boolean;
  label: string;
  onClick: () => void;
  // Something small set before the label: the swatch of a status.
  adornment?: ReactNode;
  disabled?: boolean;
  // Set tight, as the headers' menus are.
  dense?: boolean;
  // Set in under a section row, so the values read as its own.
  indented?: boolean;
  // What a menu's list hands the item the keyboard starts on when the menu
  // opens (MUI's MenuList clones that child with them). Without them a menu
  // whose first item is one of these opens with the focus on its frame,
  // where the arrow keys do nothing.
  autoFocus?: boolean;
  tabIndex?: number;
}

// A choice that can be on or off in a menu of several: an item with the
// checkbox role holding a small checkbox and the label. The menus of a
// page's choices (HubSelect) and the headers' facet menus both render their
// rows with it, so the two kinds of menu stay alike. The ref reaches the
// item, for whoever needs to know where a section ends.
const CheckMenuItem = forwardRef<HTMLLIElement, CheckMenuItemProps>(
  function CheckMenuItem(
    {
      checked,
      label,
      onClick,
      adornment,
      disabled = false,
      dense = false,
      indented = false,
      autoFocus,
      tabIndex,
    },
    ref
  ) {
    // The focus is taken as the item mounts, which is as its menu opens,
    // and not after: the list names whichever item it would start on now,
    // and one that becomes that item under an open menu, a choice that can
    // be unticked again once another is ticked, must not take the focus
    // from the item the reader just pressed.
    const [focusOnMount] = useState(autoFocus);
    return (
      <MenuItem
        ref={ref}
        role="menuitemcheckbox"
        aria-checked={checked}
        dense={dense}
        disabled={disabled}
        autoFocus={focusOnMount}
        tabIndex={tabIndex}
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
        {adornment !== undefined && (
          <Box
            component="span"
            sx={{ display: "inline-flex", alignItems: "center", mr: 1 }}
          >
            {adornment}
          </Box>
        )}
        <ListItemText primary={label} />
      </MenuItem>
    );
  }
);

export default CheckMenuItem;
