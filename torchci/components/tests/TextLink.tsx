import { Link, useTheme } from "@mui/material";
import { endsTextSelection } from "lib/tests/selection";
import NextLink from "next/link";
import { MouseEvent, ReactNode } from "react";

export interface TextLinkProps {
  href: string;
  // The link's color: HUD's link blue, which says at a glance that the text
  // can be followed, or the text's own, for a link that should sit among
  // the words around it, the healthy word of a Health cell.
  tone?: "link" | "text";
  children: ReactNode;
}

// Text in a cell that leads to another page. In HUD's link blue, the color
// of the links in HUD's other tables (`--link-color`, which follows the
// theme's mode), it reads as the link it is: the case name and the
// duration figure. In the text's tone it reads as its neighbours do. Either
// way it underlines at full strength when hovered, where the text that
// filters (TextButton) underlines in the disabled grey: the one hover says
// the page changes, the other that the table narrows. It is a real link, so
// it opens in a new tab with the modifier keys and the middle button, can
// be copied from its context menu, shows where it leads in the status bar
// and is reached by Tab and followed by Enter; the page's own router
// follows a plain click. Its text is selectable, to copy, like the rest of
// the row: dragging across a link drags the link in most browsers, so the
// link is marked not draggable, and Chrome lets a selection begin inside a
// link only where `user-select: text` is set, so it is; a drag then selects
// the text, and the click that ends the drag goes nowhere
// (endsTextSelection). The link is an inline block: Chrome cannot start a
// drag selection in an inline element with several child nodes, text and
// <wbr> alike, at a half-pixel offset (see TestName), and a case name is
// such text. The table's own rule sets a cell's links in the link blue and
// reads `--cell-link-color` first (TestsTable), so the text tone names the
// inherited color there.
export default function TextLink({
  href,
  tone = "link",
  children,
}: TextLinkProps) {
  const theme = useTheme();
  return (
    <Link
      component={NextLink}
      href={href}
      prefetch={false}
      draggable={false}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (endsTextSelection(event)) {
          event.preventDefault();
        }
      }}
      underline="hover"
      color="inherit"
      sx={{
        display: "inline-block",
        maxWidth: "100%",
        verticalAlign: "baseline",
        userSelect: "text",
        color: tone === "link" ? "var(--link-color)" : "inherit",
        "--cell-link-color":
          tone === "link" ? "var(--link-color)" : "currentColor",
        textDecorationColor: "currentcolor",
        textUnderlineOffset: "0.15em",
        borderRadius: "2px",
        "&:focus-visible": {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 1,
        },
      }}
    >
      {children}
    </Link>
  );
}
