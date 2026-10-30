import { Checkbox, FormControlLabel, Tooltip, useTheme } from "@mui/material";
import { HEADER_FILTER_SIZE } from "components/tests/HeaderFilter";
import {
  headerKeyColors,
  headerKeyFocusRing,
  headerKeySx,
} from "lib/tests/headerColors";

export interface HeaderCheckProps {
  // What the key shows: "Time bar".
  label: string;
  // What checking it does, for the tooltip: "Show the time bar under each
  // configuration's runs".
  title: string;
  checked: boolean;
  // Greyed and unresponsive: the choice is not on offer here, the title
  // saying so.
  disabled?: boolean;
  onChange: (_checked: boolean) => void;
}

// One on-or-off choice set in a table's header band beside the HeaderSelect
// keys: a key of the same height, background and ruled edge, holding a
// small checkbox and its label. The whole key is the label, so a click
// anywhere on it toggles, and the key takes the keys' focus ring when the
// checkbox has focus. Every color follows the theme's mode.
export default function HeaderCheck({
  label,
  title,
  checked,
  disabled = false,
  onChange,
}: HeaderCheckProps) {
  const theme = useTheme();
  // A key at rest: the check inside it says what is chosen.
  const key = headerKeyColors(theme);
  return (
    <Tooltip title={title} enterDelay={400}>
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={checked}
            disabled={disabled}
            disableRipple
            onChange={(event) => onChange(event.target.checked)}
            sx={{ p: 0, mr: 0.75, "& .MuiSvgIcon-root": { fontSize: 18 } }}
          />
        }
        label={label}
        disabled={disabled}
        sx={{
          m: 0,
          height: HEADER_FILTER_SIZE,
          pl: 0.75,
          pr: 1,
          ...headerKeySx(theme, key),
          whiteSpace: "nowrap",
          userSelect: "none",
          "&:has(input:focus-visible)": headerKeyFocusRing(theme),
          // Disabled, the key keeps its frame but its edge no longer
          // answers the pointer, and the hand is not offered.
          ...(disabled
            ? { cursor: "default", "&:hover": { borderColor: key.edge } }
            : {}),
          // The band around it sets its labels small, bold and uppercase;
          // the choice is read as text, as the keys' choices are.
          "& .MuiFormControlLabel-label": {
            fontFamily: theme.typography.fontFamily,
            fontSize: theme.typography.body2.fontSize,
            fontWeight: 400,
            letterSpacing: "normal",
            textTransform: "none",
            lineHeight: 1,
          },
        }}
      />
    </Tooltip>
  );
}
