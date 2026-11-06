import { ButtonBase, Tooltip, useTheme } from "@mui/material";
import {
  headerKeyColors,
  headerKeyFocusRing,
  headerKeySx,
} from "lib/tests/headerColors";
import { HEADER_FILTER_SIZE } from "lib/tests/layout";
import type { ReactNode } from "react";

export interface KeyButtonProps {
  // What pressing it does, for the tooltip.
  title: string;
  // Filled in the accent: the choice in force. Left out, the key is an
  // action, not a choice, and is never pressed.
  active?: boolean;
  // Not a choice now; the title says why.
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}

// A key that is pressed rather than opened: the same height, ruled edge and
// colors as HeaderSelect and HeaderCheck, filled in the accent while its
// choice is in force, so a row of them reads as one choice among several.
// A key that is not a choice now is marked aria-disabled, faded and inert,
// but stays focusable and under the pointer: its tooltip says why, it keeps
// its name (an icon key has no other), and a key the reader just pressed
// that turns off, as › at the last owner, keeps the focus.
export default function KeyButton({
  title,
  active,
  disabled = false,
  onClick,
  children,
}: KeyButtonProps) {
  const theme = useTheme();
  const colors = headerKeyColors(theme, { active });
  return (
    <Tooltip title={title} enterDelay={400}>
      <ButtonBase
        aria-pressed={active}
        aria-disabled={disabled || undefined}
        onClick={disabled ? undefined : onClick}
        sx={{
          height: HEADER_FILTER_SIZE,
          px: 1.25,
          typography: "body2",
          lineHeight: 1,
          whiteSpace: "nowrap",
          ...headerKeySx(theme, colors),
          "&.Mui-focusVisible": headerKeyFocusRing(theme),
          '&[aria-disabled="true"]': {
            opacity: 0.45,
            cursor: "default",
            "&:hover": {
              backgroundColor: colors.background,
              borderColor: colors.edge,
            },
          },
        }}
      >
        {children}
      </ButtonBase>
    </Tooltip>
  );
}
