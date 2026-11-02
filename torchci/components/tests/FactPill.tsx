import { Box, useTheme } from "@mui/material";
import { darken } from "@mui/material/styles";
import { VIEW_CHIP_HEIGHT } from "components/tests/ViewChips";
import {
  accentPillColors,
  headerBandColor,
  headerKeyFocusRing,
} from "lib/tests/headerColors";
import NextLink from "next/link";
import { ReactNode } from "react";

export interface FactPillProps {
  // A mark before the words, when the fact has one: the language's dot.
  mark?: ReactNode;
  // A muted word in title case for what the fact is, "First Seen"; a fact
  // that is its own word, the language, has none.
  label?: string;
  // The value is not there, "Unknown", and stays muted, so a value that is
  // there stands out.
  muted?: boolean;
  // A GitHub-blue pill for a reference, the pull request's number; the
  // words take the tone's own ink.
  tone?: "accent";
  // A tooltip for the whole pill, when its words leave something to say.
  title?: string;
  // Where the pill leads, when it does: the whole pill is the link, and
  // darkens under the pointer.
  href?: string;
  // The value, a step heavier than the label.
  children: ReactNode;
}

// One fact of a page header's row, as a pill in the grey of the title's
// pills and the table's header band, a view chip's height: a mark, when the
// fact has one, a muted word in title case for what it is, "First Seen",
// then the value a step heavier; a fact that is its own word, the language,
// has no label. A value the catalog does not have is said, "Unknown", and
// stays muted, so a value that is there stands out. The pill is a plain
// span, read and not pressed, unless it has somewhere to lead: then it is
// the link, and under the pointer it darkens. In the accent tone the pill
// is GitHub's blue with white ink.
export default function FactPill({
  mark,
  label,
  muted = false,
  tone,
  title,
  href,
  children,
}: FactPillProps) {
  const theme = useTheme();
  const toneColors = tone === "accent" ? accentPillColors(theme) : null;
  const background = toneColors?.background ?? headerBandColor(theme);
  const sx = {
    display: "inline-flex",
    alignItems: "center",
    gap: 0.75,
    height: VIEW_CHIP_HEIGHT,
    px: 1.25,
    borderRadius: "999px",
    backgroundColor: background,
    color: toneColors?.text ?? "text.secondary",
    whiteSpace: "nowrap",
    textDecoration: "none",
    ...(href === undefined
      ? {}
      : {
          "&:hover": { backgroundColor: darken(background, 0.12) },
          "&:focus-visible": headerKeyFocusRing(theme),
        }),
  };
  const words = (
    <>
      {mark}
      {label !== undefined && <span>{label}</span>}
      <Box
        component="span"
        sx={
          muted
            ? undefined
            : {
                color: toneColors ? "inherit" : "text.primary",
                fontWeight: 500,
              }
        }
      >
        {children}
      </Box>
    </>
  );
  if (href !== undefined) {
    return (
      <Box
        component={NextLink}
        href={href}
        prefetch={false}
        title={title}
        sx={sx}
      >
        {words}
      </Box>
    );
  }
  return (
    <Box component="span" title={title} sx={sx}>
      {words}
    </Box>
  );
}
