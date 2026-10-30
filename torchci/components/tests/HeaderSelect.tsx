import KeyboardArrowDownRoundedIcon from "@mui/icons-material/KeyboardArrowDownRounded";
import {
  ButtonBase,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  useTheme,
} from "@mui/material";
import CheckMenuItem from "components/tests/CheckMenuItem";
import { HEADER_FILTER_SIZE } from "components/tests/HeaderFilter";
import type { InlineSelectOption } from "components/tests/InlineSelect";
import {
  headerKeyColors,
  headerKeyFocusRing,
  headerKeySx,
} from "lib/tests/headerColors";
import { MouseEvent, ReactNode, useId, useState } from "react";

export interface HeaderSelectOption<Value extends string>
  extends InlineSelectOption<Value> {
  // Something small set before the label in the menu: a status's swatch.
  adornment?: ReactNode;
}

interface HeaderSelectCommonProps<Value extends string> {
  // What the control chooses, for assistive technology and the tooltip:
  // "Code source".
  label: string;
  // What the key shows: the choice's label, "main".
  display: string;
  options: readonly HeaderSelectOption<Value>[];
  // The key is filled in the accent, as a header's filter key is while
  // something is chosen: the choice narrows what the table shows.
  active?: boolean;
}

export type HeaderSelectProps<Value extends string> =
  HeaderSelectCommonProps<Value> &
    (
      | { multiple?: false; value: Value; onChange: (_value: Value) => void }
      | {
          multiple: true;
          value: readonly Value[];
          onChange: (_value: Value[]) => void;
          // The menu's first item, which chooses every option: "All
          // outcomes"; marked when every option is chosen.
          allLabel: string;
        }
    );

// One choice set in a table's header band: a key in the page's background
// color with a ruled edge, as the headers' filter keys are (HeaderFilter),
// holding the choice in the text's own case and size with a chevron, that
// opens a menu of one list. A single choice closes the menu; several, set
// as the headers' menus set theirs (CheckMenuItem), keep it open until the
// reader is done, and the last one chosen cannot be unchosen, so the table
// always shows something. The key is edged in the accent while its menu is
// open, filled in it while `active`, and its tooltip names what it chooses.
// Every color follows the theme's mode.
export default function HeaderSelect<Value extends string>(
  props: HeaderSelectProps<Value>
) {
  const { label, display, options, active = false } = props;
  const theme = useTheme();
  const menuId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = anchor !== null;
  const key = headerKeyColors(theme, { active, open });
  // The chevron is muted on a key at rest and the text's color on a filled
  // one.
  const chevron = active ? key.color : theme.palette.text.secondary;

  const isChosen = (value: Value) =>
    props.multiple ? props.value.includes(value) : props.value === value;
  const choose = (value: Value) => {
    if (props.multiple) {
      props.onChange(
        props.value.includes(value)
          ? props.value.filter((chosen) => chosen !== value)
          : options
              .map((option) => option.value)
              .filter((each) => each === value || props.value.includes(each))
      );
    } else {
      props.onChange(value);
      setAnchor(null);
    }
  };
  const everyChosen =
    props.multiple && options.every((option) => isChosen(option.value));

  return (
    <>
      <Tooltip title={label} enterDelay={400}>
        <ButtonBase
          aria-haspopup="menu"
          aria-controls={open ? menuId : undefined}
          aria-expanded={open}
          aria-label={`${label}: ${display}`}
          onClick={(event: MouseEvent<HTMLElement>) =>
            setAnchor(event.currentTarget)
          }
          sx={{
            height: HEADER_FILTER_SIZE,
            pl: 1,
            pr: 0.5,
            ...headerKeySx(theme, key),
            // The band around it sets its labels small, bold and uppercase;
            // the choice is read as text.
            fontFamily: theme.typography.fontFamily,
            fontSize: theme.typography.body2.fontSize,
            fontWeight: 400,
            letterSpacing: "normal",
            textTransform: "none",
            whiteSpace: "nowrap",
            gap: 0.25,
            "&.Mui-focusVisible": headerKeyFocusRing(theme),
          }}
        >
          {display}
          <KeyboardArrowDownRoundedIcon
            aria-hidden
            sx={{ fontSize: 18, color: chevron }}
          />
        </ButtonBase>
      </Tooltip>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={open}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        slotProps={{ paper: { sx: { mt: 0.5, minWidth: 160 } } }}
      >
        {props.multiple && (
          <MenuItem
            role="menuitemradio"
            aria-checked={everyChosen}
            selected={everyChosen}
            onClick={() =>
              props.onChange(options.map((option) => option.value))
            }
          >
            <ListItemText primary={props.allLabel} />
          </MenuItem>
        )}
        {options.map((option) =>
          props.multiple ? (
            <CheckMenuItem
              key={option.value}
              checked={isChosen(option.value)}
              label={option.label}
              adornment={option.adornment}
              // The last one chosen stays chosen.
              disabled={
                option.disabled ||
                (isChosen(option.value) && props.value.length === 1)
              }
              onClick={() => choose(option.value)}
            />
          ) : (
            <MenuItem
              key={option.value}
              role="menuitemradio"
              aria-checked={isChosen(option.value)}
              selected={isChosen(option.value)}
              disabled={option.disabled}
              onClick={() => choose(option.value)}
            >
              <ListItemText primary={option.label} />
            </MenuItem>
          )
        )}
      </Menu>
    </>
  );
}
