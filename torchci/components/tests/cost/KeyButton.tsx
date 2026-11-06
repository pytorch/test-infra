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
  // Filled in the accent: the choice in force.
  active?: boolean;
  // Not a choice now; the title says why.
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}

// A key that is pressed rather than opened: the same height, ruled edge and
// colors as HeaderSelect and HeaderCheck, filled in the accent while its
// choice is in force, so a row of them reads as one choice among several.
export default function KeyButton({
  title,
  active = false,
  disabled = false,
  onClick,
  children,
}: KeyButtonProps) {
  const theme = useTheme();
  const button = (
    <ButtonBase
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      sx={{
        height: HEADER_FILTER_SIZE,
        px: 1.25,
        typography: "body2",
        lineHeight: 1,
        whiteSpace: "nowrap",
        ...headerKeySx(theme, headerKeyColors(theme, { active })),
        "&.Mui-focusVisible": headerKeyFocusRing(theme),
        "&.Mui-disabled": { opacity: 0.45 },
      }}
    >
      {children}
    </ButtonBase>
  );
  return (
    <Tooltip title={title} enterDelay={400}>
      {/* A disabled button takes no pointer, so a span holds the tooltip. */}
      {disabled ? (
        <span style={{ display: "inline-flex" }}>{button}</span>
      ) : (
        button
      )}
    </Tooltip>
  );
}
