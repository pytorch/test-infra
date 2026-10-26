import { ButtonBase, Tooltip, useTheme } from "@mui/material";
import { endsTextSelection } from "lib/tests/selection";
import { MouseEvent, ReactNode } from "react";

export interface TextButtonProps {
  // What a click does, for assistive technology: "Only CUDA 13.2".
  label: string;
  // Shown on hover, for text that is short for something.
  tooltip?: string;
  onClick: () => void;
  // Given, text too long for its line runs on to the next, as a part of a
  // test's name does; a token keeps to one line.
  wrap?: boolean;
  children: ReactNode;
}

// Text in a cell that acts. It reads as plain text and underlines when
// hovered, as a link does; its click does not reach the row around it. It is
// a span with the button role, which ButtonBase makes focusable and operable
// by Enter and Space, not a <button>: a <button> is one box however it is
// displayed (HTML lays out an inline button as an inline block), so its text
// cannot run on over lines with the text around it, what wraps inside it is
// centered, and not every browser lets its text be selected. The text here
// is selectable, to copy, like the rest of the row: a drag across it selects
// it, and the click that ends the drag does nothing (endsTextSelection).
// There is no ripple: a ripple fills a box, and this is text in a line.
export default function TextButton({
  label,
  tooltip,
  onClick,
  wrap = false,
  children,
}: TextButtonProps) {
  const theme = useTheme();
  const button = (
    <ButtonBase
      component="span"
      disableRipple
      onClick={(event: MouseEvent<HTMLElement>) => {
        event.stopPropagation();
        if (endsTextSelection(event)) {
          return;
        }
        onClick();
      }}
      aria-label={label}
      sx={{
        // Inline, not the inline-flex of a button, so it sits in its line of
        // text.
        display: "inline",
        font: "inherit",
        letterSpacing: "inherit",
        lineHeight: "inherit",
        color: "inherit",
        verticalAlign: "baseline",
        whiteSpace: wrap ? "normal" : "nowrap",
        // ButtonBase forbids selecting a button's text; this text is to copy.
        userSelect: "text",
        borderRadius: "2px",
        "&:hover": {
          textDecoration: "underline",
          textDecorationColor: theme.palette.text.disabled,
          textUnderlineOffset: "0.15em",
        },
        "&.Mui-focusVisible": {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 1,
        },
      }}
    >
      {children}
    </ButtonBase>
  );
  return tooltip === undefined ? (
    button
  ) : (
    <Tooltip title={tooltip} enterDelay={300}>
      {button}
    </Tooltip>
  );
}
