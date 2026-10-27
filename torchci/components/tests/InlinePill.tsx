import KeyboardArrowDownRoundedIcon from "@mui/icons-material/KeyboardArrowDownRounded";
import { ButtonBase, useTheme } from "@mui/material";
import { headerBandColor } from "lib/tests/headerColors";
import { MouseEvent } from "react";

export interface InlinePillProps {
  // What the control chooses, for assistive technology: "Window".
  label: string;
  // What the pill shows: the choice phrased for the sentence around it.
  display: string;
  // The menu the pill opens and whether it is open.
  menuId: string;
  open: boolean;
  onOpen: (_anchor: HTMLElement) => void;
}

// The one control the title's sentence is made of: a flat grey pill set in
// the text's own font, with a chevron, that opens a menu. The pill is the
// grey of the table's header band (headerBandColor), a step darker when
// hovered; both follow the theme's mode.
export default function InlinePill({
  label,
  display,
  menuId,
  open,
  onOpen,
}: InlinePillProps) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  return (
    <ButtonBase
      onClick={(event: MouseEvent<HTMLElement>) => onOpen(event.currentTarget)}
      aria-haspopup="menu"
      aria-controls={open ? menuId : undefined}
      aria-expanded={open}
      aria-label={`${label}: ${display}`}
      sx={{
        font: "inherit",
        letterSpacing: "inherit",
        lineHeight: 1.2,
        display: "inline-flex",
        alignItems: "center",
        verticalAlign: "baseline",
        whiteSpace: "nowrap",
        padding: "0.05em 0.3em 0.05em 0.55em",
        borderRadius: "999px",
        color: "inherit",
        backgroundColor: headerBandColor(theme),
        transition: theme.transitions.create("background-color", {
          duration: theme.transitions.duration.shortest,
        }),
        "&:hover": {
          backgroundColor: dark
            ? theme.palette.grey[700]
            : theme.palette.grey[300],
        },
        "&.Mui-focusVisible": {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 2,
        },
      }}
    >
      {display}
      <KeyboardArrowDownRoundedIcon
        aria-hidden
        sx={{ fontSize: "0.8em", color: "text.secondary", ml: "0.05em" }}
      />
    </ButtonBase>
  );
}
