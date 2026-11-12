import KeyboardArrowDownRoundedIcon from "@mui/icons-material/KeyboardArrowDownRounded";
import { Box, useTheme } from "@mui/material";
import { darken } from "@mui/material/styles";
import { VIEW_CHIP_HEIGHT } from "components/tests/ViewChips";
import {
  headerBandColor,
  headerBandHoverColor,
  headerKeyFocusRing,
  pillChipColors,
  PillTone,
  tonePillColors,
} from "lib/tests/headerColors";
import NextLink from "next/link";
import { forwardRef, ReactNode } from "react";

// A second fact set inside a pill's end (FactPillProps.chip).
export interface FactPillChip {
  // Where it leads: the chip is a link of its own.
  href: string;
  // What it is, for a reader who does not see where it sits: "Commit
  // 573c889".
  name: string;
  // A tooltip, when its words leave something to say.
  title?: string;
  // Its words.
  children: ReactNode;
}

// How far inside the pill's edge its chip sits, in px: the two ends are
// concentric.
const CHIP_INSET = 2;

export interface FactPillProps {
  // A mark before the words, when the fact has one: the language's dot, a
  // status's lamp.
  mark?: ReactNode;
  // A muted word in title case for what the fact is, "First Seen"; a fact
  // that is its own word, the language, has none.
  label?: string;
  // The value is not there, "Unknown", and stays muted, so a value that is
  // there stands out.
  muted?: boolean;
  // A colored pill, the words in the tone's own ink: a status's tone, green
  // or yellow, for a verdict (tonePillColors).
  tone?: PillTone;
  // A tooltip for the whole pill, when its words leave something to say.
  title?: string;
  // Where the pill leads, when it does: the whole pill is the link, and
  // darkens under the pointer.
  href?: string;
  // A second fact set inside the pill's end, where it belongs to the first:
  // the commit inside its pull request. It is a chip on the page's own
  // background and a link of its own beside the pill's; in a pill with no
  // link of its own the chip's is the whole pill's.
  chip?: FactPillChip;
  // Given, the pill is a button that opens something under it, and ends in
  // a chevron, as the title's pills do (InlinePill).
  onClick?: () => void;
  // For a button: whether what it opens is open, and that element's id.
  // While it is open the pill keeps the look it has under the pointer.
  expanded?: boolean;
  controls?: string;
  // The value, a step heavier than the label; a pill whose chip is its
  // value has none.
  children?: ReactNode;
}

// One fact of a page header's row, as a pill in the grey of the title's
// pills and the table's header band, a view chip's height: a mark, when the
// fact has one, a muted word in title case for what it is, "First Seen",
// then the value a step heavier; a fact that is its own word, the language,
// has no label. A value the catalog does not have is said, "Unknown", and
// stays muted, so a value that is there stands out. The pill is a plain
// span, read and not pressed, unless it has somewhere to lead: then it is
// the link, and under the pointer it darkens; or something to open: then
// it is a button, with a chevron that turns over while that is open, and
// for as long it keeps the look it has under the pointer, so the pill and
// what hangs from it read as one. In a tone the pill takes the tone's
// colors, a status's hue, pale, with the hue's ink.
//
// With a chip the pill holds two facts, the second inside the first: the
// chip sits in the pill's end on the page's own background, as a header key
// sits on the band, and is a link of its own. Each of the two answers the
// pointer alone: on the pill's words the pill darkens, on the chip the chip
// is ringed; from the keyboard the pill's link rings the pill and the
// chip's the chip. The chip is pressed over the pill's whole height. A pill
// with no link of its own is the chip's whole, pressed anywhere, and
// answers as one link does. The ref is the pill's element, for whoever
// places something by it.
const FactPill = forwardRef<HTMLElement, FactPillProps>(function FactPill(
  {
    mark,
    label,
    muted = false,
    tone,
    title,
    href,
    chip,
    onClick,
    expanded = false,
    controls,
    children,
  },
  ref
) {
  const theme = useTheme();
  const toneColors = tone === undefined ? null : tonePillColors(theme, tone);
  const background = toneColors?.background ?? headerBandColor(theme);
  const pressed = href !== undefined || onClick !== undefined;
  // A status's tone: the label and the value share the tone's ink, which
  // is at the contrast small text needs and cannot be made fainter, so the
  // value is told from the label by weight, a step heavier than elsewhere.
  const statusTone = tone !== undefined;
  // Under the pointer: a status's pill is ringed in its ink, as a Health
  // block is; a button in the facts' grey goes a step darker, as the title's
  // pills do; a link darkens.
  const hover = statusTone
    ? { boxShadow: "inset 0 0 0 1px currentColor" }
    : {
        backgroundColor:
          onClick !== undefined
            ? headerBandHoverColor(theme)
            : darken(background, 0.12),
      };
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
    // A pill with a chip answers by its parts (below).
    ...(pressed && chip === undefined
      ? {
          "&:hover": hover,
          "&:focus-visible": headerKeyFocusRing(theme),
        }
      : {}),
  };
  const words = (
    <>
      {mark}
      {label !== undefined && <span>{label}</span>}
      {children != null && (
        <Box
          component="span"
          sx={
            muted
              ? undefined
              : {
                  color: toneColors ? "inherit" : "text.primary",
                  fontWeight: statusTone ? 600 : 500,
                }
          }
        >
          {children}
        </Box>
      )}
    </>
  );
  if (chip !== undefined) {
    const chipColors = pillChipColors(theme);
    const focusRing = headerKeyFocusRing(theme);
    const shortest = { duration: theme.transitions.duration.shortest };
    // With no link of the pill's own the chip's is the only one, and the
    // whole pill is pressed for it.
    const whole = href === undefined;
    const wordsSx = {
      display: "inline-flex",
      alignItems: "center",
      gap: 0.75,
      height: "100%",
      pl: 1.25,
      pr: 1,
      borderRadius: "999px 0 0 999px",
      color: "inherit",
      textDecoration: "none",
      // Its focus rings the pill (below), not the words alone.
      outline: "none",
    };
    return (
      <Box
        ref={ref}
        component="span"
        sx={{
          ...sx,
          position: "relative",
          gap: 0,
          px: 0,
          pr: `${CHIP_INSET}px`,
          transition: theme.transitions.create("background-color", shortest),
          ...(whole
            ? { "&:hover": hover, "&:has(> a:focus-visible)": focusRing }
            : {
                "&:has(> a:first-of-type:hover)": hover,
                "&:has(> a:first-of-type:focus-visible)": focusRing,
              }),
        }}
      >
        {whole ? (
          // The chip's link names the fact; the word is not said twice.
          <Box component="span" aria-hidden title={title} sx={wordsSx}>
            {words}
          </Box>
        ) : (
          <Box
            component={NextLink}
            href={href}
            prefetch={false}
            title={title}
            sx={wordsSx}
          >
            {words}
          </Box>
        )}
        <Box
          component={NextLink}
          href={chip.href}
          prefetch={false}
          title={chip.title}
          aria-label={chip.name}
          sx={{
            position: whole ? "static" : "relative",
            display: "inline-flex",
            alignItems: "center",
            height: VIEW_CHIP_HEIGHT - 2 * CHIP_INSET,
            px: 1,
            borderRadius: "999px",
            backgroundColor: chipColors.background,
            color: chipColors.text,
            fontWeight: 500,
            textDecoration: "none",
            boxShadow: chipColors.rest,
            transition: theme.transitions.create("box-shadow", shortest),
            ...(whole
              ? { outline: "none" }
              : {
                  "&:hover": { boxShadow: chipColors.hover },
                  "&:focus-visible": focusRing,
                }),
            // Where it is pressed: out to the pill's edge, over its whole
            // height, and as the pill's only link over the whole pill.
            "&::after": {
              content: '""',
              position: "absolute",
              inset: whole ? 0 : `-${CHIP_INSET}px`,
              borderRadius: "999px",
            },
          }}
        >
          {chip.children}
        </Box>
      </Box>
    );
  }
  if (onClick !== undefined) {
    return (
      <Box
        ref={ref}
        component="button"
        type="button"
        title={title}
        aria-expanded={expanded}
        aria-controls={expanded ? controls : undefined}
        onClick={onClick}
        sx={{
          ...sx,
          ...(expanded ? hover : {}),
          // Its look under the pointer and while open comes and goes
          // softly, as its chevron turns.
          transition: theme.transitions.create(
            ["background-color", "box-shadow"],
            { duration: theme.transitions.duration.shortest }
          ),
          // A button that looks like the pills beside it: no border, the
          // row's own text.
          border: 0,
          m: 0,
          pr: 0.75,
          font: "inherit",
          letterSpacing: "inherit",
          cursor: "pointer",
        }}
      >
        {words}
        <KeyboardArrowDownRoundedIcon
          aria-hidden
          sx={{
            fontSize: 18,
            ml: -0.25,
            opacity: 0.7,
            transform: expanded ? "rotate(180deg)" : "none",
            transition: theme.transitions.create("transform", {
              duration: theme.transitions.duration.shorter,
            }),
          }}
        />
      </Box>
    );
  }
  if (href !== undefined) {
    return (
      <Box
        ref={ref}
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
    <Box ref={ref} component="span" title={title} sx={sx}>
      {words}
    </Box>
  );
});

export default FactPill;
