import KeyboardArrowDownRoundedIcon from "@mui/icons-material/KeyboardArrowDownRounded";
import {
  Box,
  ButtonBase,
  ListItemText,
  Menu,
  MenuItem,
  Skeleton,
  useTheme,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import CheckMenuItem from "components/tests/CheckMenuItem";
import {
  HEADER_KEY_RADIUS,
  headerKeyColors,
  headerKeyFocusRing,
} from "lib/tests/headerColors";
import { MouseEvent, useId, useState } from "react";

// The control's height in pixels, which its placeholder keeps.
export const HUB_SELECT_HEIGHT = 32;

export interface HubSelectOption<Value extends string> {
  value: Value;
  label: string;
  disabled?: boolean;
}

interface HubSelectCommonProps<Value extends string> {
  // What the control chooses, set before the choice: "Window".
  label: string;
  // The choice as the control says it: "12 hours".
  display: string;
  options: readonly HubSelectOption<Value>[];
  // A line at the top of the menu saying how its choices combine: "None
  // chosen means all".
  hint?: string;
}

export type HubSelectProps<Value extends string> = HubSelectCommonProps<Value> &
  (
    | { multiple?: false; value: Value; onChange: (_value: Value) => void }
    | {
        multiple: true;
        value: readonly Value[];
        // The chosen values, in the menu's order.
        onChange: (_value: Value[]) => void;
        // The last one chosen stays chosen: its item cannot be unticked.
        required?: boolean;
      }
  );

// The hint is a line of the menu, not one of its items: the menu's list
// neither focuses it when the menu opens nor stops on it with the arrow
// keys (MUI's MenuList skips a child marked this way).
function Hint({ id, text }: { id: string; text: string }) {
  return (
    <Box
      component="li"
      id={id}
      role="presentation"
      sx={{
        px: 2,
        pt: 0.25,
        pb: 0.75,
        typography: "caption",
        color: "text.secondary",
      }}
    >
      {text}
    </Box>
  );
}
Hint.muiSkipListHighlight = true;

// One of a page's choices, set at the right end of the tabs' row (HubTabs):
// what it chooses and the choice, "Window 12 hours", in a key with a ruled
// edge and a chevron, that opens a menu of one list. The name is muted and
// the choice is not, so a row of them reads as its choices; the edge is the
// header keys' (headerKeyColors), a control on the page's background in
// either theme, and takes the accent with a ring of its wash while the menu
// is open. A single choice closes the menu; several, set as the headers'
// menus set theirs (CheckMenuItem), keep it open until the reader is done.
// The menu hangs from the key's right edge: the row's controls are set
// against the row's right end, so that edge stays where it is while a
// choice makes the key wider or narrower under an open menu.
export default function HubSelect<Value extends string>(
  props: HubSelectProps<Value>
) {
  const { label, display, options, hint } = props;
  const theme = useTheme();
  const menuId = useId();
  const hintId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = anchor !== null;
  const key = headerKeyColors(theme, { open });
  const dark = theme.palette.mode === "dark";

  const isChosen = (value: Value) =>
    props.multiple ? props.value.includes(value) : props.value === value;
  const choose = (value: Value) => {
    if (props.multiple) {
      props.onChange(
        options
          .map((option) => option.value)
          .filter((each) => (each === value ? !isChosen(each) : isChosen(each)))
      );
    } else {
      props.onChange(value);
      setAnchor(null);
    }
  };

  return (
    <>
      <ButtonBase
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        onClick={(event: MouseEvent<HTMLElement>) =>
          setAnchor(event.currentTarget)
        }
        sx={{
          flex: "none",
          height: HUB_SELECT_HEIGHT,
          pl: 1.5,
          pr: 0.75,
          gap: 0.75,
          borderRadius: HEADER_KEY_RADIUS,
          border: `1px solid ${key.edge}`,
          backgroundColor: key.background,
          color: theme.palette.text.primary,
          // Lifted a little off the page at rest; ringed in the accent's
          // wash while its menu is open.
          boxShadow: open
            ? `0 0 0 3px ${alpha(
                theme.palette.primary.main,
                theme.palette.action.selectedOpacity
              )}`
            : dark
            ? "0 1px 2px rgba(0, 0, 0, 0.4)"
            : "0 1px 1.5px rgba(0, 0, 0, 0.05)",
          fontFamily: theme.typography.fontFamily,
          fontSize: theme.typography.body2.fontSize,
          whiteSpace: "nowrap",
          transition: theme.transitions.create(["border-color", "box-shadow"], {
            duration: theme.transitions.duration.shortest,
          }),
          "@media (prefers-reduced-motion: reduce)": { transition: "none" },
          "&:hover": { borderColor: key.hoverEdge },
          "&.Mui-focusVisible": headerKeyFocusRing(theme),
        }}
      >
        <Box component="span" sx={{ color: "text.secondary" }}>
          {label}
        </Box>
        {
          // Between the two for whoever reads the button's name out; the
          // row lays its items out with a gap and ignores it.
          " "
        }
        <Box component="span" sx={{ fontWeight: 500 }}>
          {display}
        </Box>
        <KeyboardArrowDownRoundedIcon
          aria-hidden
          sx={{ fontSize: 18, color: "text.secondary" }}
        />
      </ButtonBase>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={open}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: { sx: { mt: 0.5, minWidth: 180 } },
          list: { "aria-describedby": hint === undefined ? undefined : hintId },
        }}
      >
        {hint !== undefined && <Hint id={hintId} text={hint} />}
        {options.map((option) =>
          props.multiple ? (
            <CheckMenuItem
              key={option.value}
              checked={isChosen(option.value)}
              label={option.label}
              disabled={
                option.disabled ||
                (props.required === true &&
                  props.value.length === 1 &&
                  isChosen(option.value))
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

// A control's place until its choices arrive, at the width given.
export function HubSelectSkeleton({ width }: { width: number | string }) {
  return (
    <Skeleton
      variant="rounded"
      width={width}
      height={HUB_SELECT_HEIGHT}
      sx={{ flex: "none", borderRadius: HEADER_KEY_RADIUS }}
    />
  );
}
