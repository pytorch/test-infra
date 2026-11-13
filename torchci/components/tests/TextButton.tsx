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
  // Given, the text opens and closes something in place: assistive
  // technology is told which it is, and a chevron after the text turns with
  // it, down when closed and up when open.
  expanded?: boolean;
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
  expanded,
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
      aria-expanded={expanded}
      sx={{
        // Inline, not the inline-flex of a button, so it sits in its line of
        // text. One that opens something is one box in the line instead, so
        // the focus ring is one rectangle around its text and chevron; it
        // keeps to one line, where the two are the same in the text.
        display: expanded === undefined ? "inline" : "inline-block",
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
        // The chevron is drawn, not an element: the control keeps one child,
        // so a drag still selects its text. It is two sides of a small
        // square, turned about the square's middle; the nudge up or down
        // keeps its point level with the text's middle either way.
        "&::after":
          expanded === undefined
            ? undefined
            : {
                content: '""',
                display: "inline-block",
                width: "0.4em",
                height: "0.4em",
                marginLeft: "0.4em",
                borderRight: "1.5px solid currentColor",
                borderBottom: "1.5px solid currentColor",
                transform: expanded
                  ? "translateY(-0.01em) rotate(225deg)"
                  : "translateY(-0.26em) rotate(45deg)",
                transition: "transform 200ms ease",
                "@media (prefers-reduced-motion: reduce)": {
                  transition: "none",
                },
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
