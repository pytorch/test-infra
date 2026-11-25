import ArrowDownwardRoundedIcon from "@mui/icons-material/ArrowDownwardRounded";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { Box, ButtonBase, Skeleton, Tooltip, useTheme } from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import type { TestOptions, TestView } from "lib/api/tests/options/types";
import type { TestSummary } from "lib/api/tests/summary/types";
import { solidHueColor, STATUS_HUES } from "lib/tests/blockColors";
import { labelOf } from "lib/tests/facets";
import {
  figureCaption,
  figureOf,
  figureSentence,
  figureText,
} from "lib/tests/figures";
import { MONOSPACE_FONT_FAMILY } from "lib/tests/header";
import {
  accentFillColor,
  accentTextColor,
  headerBandColor,
  headerRuleColor,
} from "lib/tests/headerColors";
import { viewStatuses } from "lib/tests/views";
import { useState } from "react";

// The band above the tests table: the named views of GET /api/tests/options
// as a row of cells, each two lines, the view's name over the figure that
// says how its question stands (GET /api/tests/summary) with a caption
// beside the figure, and beside both lines a button that says what a click
// does. A cell is the whole button; "Show" is drawn inside it, so the
// figure, the words and the button are one target.
//
// The cell of the view the table is showing, and only while the table shows
// exactly that view (activeViewIds), is marked as a whole: a wash of the
// accent over the cell, at the strength the theme gives a selected menu
// item, an accent rule along its foot, its name in the accent, and its
// button filled, reading "Showing". Under the pointer or the keyboard's
// focus that button reads "Clear", which is what the next click does; not
// straight after the click that chose it, when it should still say what
// just happened. The first view is the list's defaults, so its cell is the
// one marked when the page opens; there is nothing to clear it to, so it
// keeps reading "Showing" and a click on it does nothing.

// How many cells the band's place is held for before the options arrive.
const PLACEHOLDER_CELLS = 6;
// The two lines of a cell, in pixels, so the band is as tall before its
// figures arrive as after: the name, and the figure. The caption is set on
// the figure's baseline, in a line of its own height that fits inside the
// figure's.
const LABEL_LINE = 18;
const FIGURE_LINE = 26;
const CAPTION_LINE = 16;
const ACTION_HEIGHT = 24;

// The two faces of a chosen cell's button, stacked in one box so the cell
// does not move when one gives way to the other.
const SHOWING = "ViewBand-showing";
const CLEAR = "ViewBand-clear";
// On a chosen cell whose button gives "Showing" up for "Clear" under the
// pointer or the focus: every chosen cell but the one just chosen.
const SWAPS = "ViewBand-swaps";
const ACTION = "ViewBand-action";
// The button's word, which a narrow cell leaves out.
const WORD = "ViewBand-word";
// The narrowest cell, measured inside its padding, whose button keeps its
// word. Beside the button and its gap, 70px for "Show" with its arrow, a
// cell's second line holds the figure, a gap and the caption. At 250px
// that is 180px: a four-digit count (46px), the gap (8px) and the longest
// caption, "pull and trunk, 12 hours" (125px). In a narrower cell the
// button is its icon alone, a square, and the caption has 38px more. A
// caption that still does not fit ends in an ellipsis, as the slowest
// test's name does at any width. Six cells across are this wide from a
// window of about 1720px; a 1280px laptop's are 176px.
const WORDED_ACTION_MIN_WIDTH = 250;
const NARROW_CELL = `@container (max-width: ${WORDED_ACTION_MIN_WIDTH - 1}px)`;

// The band's frame: cells side by side at full width, three and then two to
// a row as the window narrows, hairlines between them and the table's own
// border around them. The hairlines are each cell's shadow, cast into the
// one pixel between cells, so a last row with fewer cells needs no filler,
// and the frame clips those at its right and bottom edges.
function bandSx(cells: number) {
  return {
    display: "grid",
    gridTemplateColumns: {
      xs: "repeat(2, minmax(0, 1fr))",
      sm: "repeat(3, minmax(0, 1fr))",
      lg: `repeat(${cells}, minmax(0, 1fr))`,
    },
    gap: "1px",
    border: "1px solid var(--table-border-color)",
    borderRadius: "4px",
    overflow: "hidden",
    mb: 1.5,
  } as const;
}

function hairlines(theme: Theme): string {
  const line = theme.palette.divider;
  return `1px 0 0 0 ${line}, 0 1px 0 0 ${line}, 1px 1px 0 0 ${line}`;
}

const CELL_PADDING = "9px 12px 8px 14px";

export interface ViewBandProps {
  // The views the options offer, in order; undefined until the options
  // arrive, when the band holds its place.
  views: readonly TestView[] | undefined;
  // The views the table is showing exactly, usually one or none.
  activeIds: readonly string[];
  // Of those, the views a click on their marked cell clears: every one but
  // the view that is the list's defaults, which clearing would lead back to.
  clearableIds: readonly string[];
  // The figures; undefined until they arrive, or after they fail.
  summary: TestSummary | undefined;
  // The figures are on their way: their places are held.
  figuresLoading: boolean;
  // The options, for the label of a figure's window, "12 hours".
  options: TestOptions | undefined;
  onChoose: (_view: TestView) => void;
  // The marked cell was clicked again.
  onClear: (_view: TestView) => void;
}

export default function ViewBand({
  views,
  activeIds,
  clearableIds,
  summary,
  figuresLoading,
  options,
  onChoose,
  onClear,
}: ViewBandProps) {
  const theme = useTheme();
  // The view chosen by the last click, until the pointer or the focus
  // leaves its cell: its button keeps reading "Showing" meanwhile.
  const [fresh, setFresh] = useState<string | null>(null);
  if (views === undefined) {
    return (
      <Box aria-hidden sx={bandSx(PLACEHOLDER_CELLS)}>
        {Array.from({ length: PLACEHOLDER_CELLS }, (_, index) => (
          <Box
            key={index}
            sx={{ p: CELL_PADDING, boxShadow: hairlines(theme) }}
          >
            <Skeleton
              variant="text"
              sx={{
                width: "9ch",
                fontSize: 12.5,
                lineHeight: `${LABEL_LINE}px`,
              }}
            />
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                height: FIGURE_LINE,
              }}
            >
              <Skeleton
                variant="text"
                sx={{
                  width: "3ch",
                  fontSize: 19,
                  lineHeight: `${FIGURE_LINE}px`,
                }}
              />
              <Skeleton
                variant="text"
                sx={{
                  width: "12ch",
                  fontSize: 12,
                  lineHeight: `${CAPTION_LINE}px`,
                }}
              />
            </Box>
          </Box>
        ))}
      </Box>
    );
  }
  if (views.length === 0) {
    return null;
  }
  const accent = theme.palette.primary.main;
  const { selectedOpacity, hoverOpacity } = theme.palette.action;
  const wash = alpha(accent, selectedOpacity);
  const washHover = alpha(accent, selectedOpacity + hoverOpacity);
  const rule = headerRuleColor(theme);
  return (
    <Box role="group" aria-label="Starter queries" sx={bandSx(views.length)}>
      {views.map((view) => {
        const active = activeIds.includes(view.id);
        const figure = figureOf(summary, view);
        const text = figure === undefined ? null : figureText(figure);
        const caption = figureCaption(view, figure);
        const sentence =
          figure === undefined || options === undefined
            ? null
            : figureSentence(
                figure,
                labelOf(figure.window, options.window.values)
              );
        // A dot for each status the cell is about that has a color.
        const hues = viewStatuses(view).flatMap((status) =>
          status in STATUS_HUES
            ? [STATUS_HUES[status as keyof typeof STATUS_HUES]]
            : []
        );
        // Nothing to count takes the color out of the dots and the figure.
        const none = text?.none === true;
        // A marked view the next click leaves; the defaults' cell is marked
        // and stays, whatever is clicked on it.
        const clearable = active && clearableIds.includes(view.id);
        const settled = active && !clearable;
        // "Showing" gives way to "Clear" under the pointer or the focus,
        // once the click that chose the view is behind it.
        const swaps = clearable && fresh !== view.id;
        const wornWash = settled ? wash : washHover;
        return (
          <Tooltip
            key={view.id}
            title={
              sentence === null
                ? view.description
                : `${view.description}\n${sentence}`
            }
            enterDelay={600}
            placement="bottom-start"
            describeChild
            slotProps={{
              tooltip: { sx: { whiteSpace: "pre-line", maxWidth: 380 } },
            }}
          >
            <ButtonBase
              disableRipple
              aria-pressed={active}
              data-view={view.id}
              className={swaps ? SWAPS : undefined}
              onClick={() => {
                if (!active) {
                  setFresh(view.id);
                  onChoose(view);
                } else if (clearable) {
                  onClear(view);
                }
              }}
              onMouseLeave={() => setFresh(null)}
              onBlur={() => setFresh(null)}
              sx={{
                ...theme.typography.body2,
                // The name over the figure and its caption, which share a
                // baseline; the button beside both lines.
                display: "grid",
                gridTemplateColumns: "auto minmax(0, 1fr) auto",
                gridTemplateRows: `${LABEL_LINE}px ${FIGURE_LINE}px`,
                alignContent: "start",
                alignItems: "baseline",
                justifyContent: "stretch",
                columnGap: "8px",
                minWidth: 0,
                // The cell is what its button sizes itself by (NARROW_CELL).
                containerType: "inline-size",
                p: CELL_PADDING,
                textAlign: "left",
                // A click on the settled cell does nothing, and it says so.
                cursor: settled ? "default" : "pointer",
                color: "text.primary",
                backgroundColor: active ? wash : "transparent",
                boxShadow: active
                  ? `${hairlines(theme)}, inset 0 -2px 0 ${accent}`
                  : hairlines(theme),
                transition: theme.transitions.create(
                  ["background-color", "box-shadow"],
                  { duration: theme.transitions.duration.shortest }
                ),
                "@media (prefers-reduced-motion: reduce)": {
                  transition: "none",
                },
                "&:active": {
                  backgroundColor: active ? wornWash : headerBandColor(theme),
                },
                "&.Mui-focusVisible": {
                  outline: `2px solid ${accent}`,
                  outlineOffset: -2,
                },
                [`& .${CLEAR}`]: { visibility: "hidden" },
                [`&.${SWAPS}.Mui-focusVisible .${SHOWING}`]: {
                  visibility: "hidden",
                },
                [`&.${SWAPS}.Mui-focusVisible .${CLEAR}`]: {
                  visibility: "visible",
                },
                // Only where a pointer can rest on the cell: a touch leaves
                // its hover behind until the next one.
                "@media (hover: hover)": {
                  "&:hover": {
                    backgroundColor: active
                      ? wornWash
                      : theme.palette.action.hover,
                  },
                  // The button's edge answers the pointer on the cell,
                  // since the cell is what is pressed.
                  [`&:hover .${ACTION}`]: active
                    ? {}
                    : { borderColor: theme.palette.text.secondary },
                  [`&.${SWAPS}:hover .${SHOWING}`]: { visibility: "hidden" },
                  [`&.${SWAPS}:hover .${CLEAR}`]: { visibility: "visible" },
                },
              }}
            >
              <Box
                component="span"
                sx={{
                  gridColumn: "1 / 3",
                  gridRow: 1,
                  display: "flex",
                  alignItems: "center",
                  gap: "7px",
                  minWidth: 0,
                  fontSize: 12.5,
                  fontWeight: 500,
                  lineHeight: `${LABEL_LINE}px`,
                  letterSpacing: 0,
                  color: active
                    ? accentTextColor(theme)
                    : theme.palette.text.secondary,
                  transition: theme.transitions.create("color", {
                    duration: theme.transitions.duration.shortest,
                  }),
                }}
              >
                {hues.length > 0 && (
                  <Box
                    component="span"
                    aria-hidden
                    sx={{ flex: "none", display: "flex", gap: "3px" }}
                  >
                    {hues.map((hue) => (
                      <Box
                        key={hue}
                        component="span"
                        sx={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          backgroundColor: none
                            ? theme.palette.text.disabled
                            : solidHueColor(theme, hue),
                        }}
                      />
                    ))}
                  </Box>
                )}
                <Box
                  component="span"
                  sx={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {view.label}
                </Box>
              </Box>
              <Box
                component="span"
                sx={{
                  gridColumn: 1,
                  gridRow: 2,
                  // The line's height is fixed: a unit set smaller beside
                  // the number would otherwise make its line taller than a
                  // bare count's, and the cells would not be as tall.
                  height: FIGURE_LINE,
                  fontSize: 19,
                  fontWeight: 700,
                  lineHeight: `${FIGURE_LINE}px`,
                  letterSpacing: "-0.01em",
                  whiteSpace: "nowrap",
                  fontVariantNumeric: "tabular-nums",
                  color:
                    text === null || none
                      ? theme.palette.text.disabled
                      : "inherit",
                }}
              >
                {text !== null ? (
                  <>
                    {text.value}
                    {text.unit !== undefined && (
                      // The space is the unit's own, at its smaller size,
                      // so the two sit close and still read as two words.
                      <Box
                        component="span"
                        sx={{
                          fontSize: 12,
                          fontWeight: 400,
                          lineHeight: 1,
                          letterSpacing: 0,
                          whiteSpace: "pre",
                          color: none
                            ? "inherit"
                            : theme.palette.text.secondary,
                        }}
                      >
                        {` ${text.unit}`}
                      </Box>
                    )}
                  </>
                ) : figuresLoading ? (
                  <Skeleton
                    variant="text"
                    sx={{ display: "inline-block", width: "2.4ch" }}
                  />
                ) : (
                  // No figure: the summary failed, or does not answer this
                  // view, or nothing passed for a slowest test to be named.
                  <span aria-hidden>—</span>
                )}
              </Box>
              <Box
                component="span"
                sx={{
                  gridColumn: 2,
                  gridRow: 2,
                  minWidth: 0,
                  fontSize: caption.name === undefined ? 12 : 11,
                  fontFamily:
                    caption.name === undefined
                      ? "inherit"
                      : MONOSPACE_FONT_FAMILY,
                  lineHeight: `${CAPTION_LINE}px`,
                  letterSpacing: 0,
                  color: theme.palette.text.secondary,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {caption.text}
              </Box>
              <Box
                component="span"
                aria-hidden
                className={ACTION}
                sx={{
                  gridColumn: 3,
                  gridRow: "1 / 3",
                  alignSelf: "center",
                  display: "inline-grid",
                  alignItems: "center",
                  height: ACTION_HEIGHT,
                  boxSizing: "border-box",
                  padding: active ? "0 8px 0 5px" : "0 5px 0 8px",
                  borderRadius: "6px",
                  border: `1px solid ${active ? accent : rule}`,
                  backgroundColor: active
                    ? accentFillColor(theme)
                    : theme.palette.background.default,
                  color: active
                    ? theme.palette.common.white
                    : theme.palette.text.primary,
                  fontSize: 12,
                  fontWeight: 500,
                  lineHeight: 1,
                  letterSpacing: 0,
                  whiteSpace: "nowrap",
                  transition: theme.transitions.create(
                    ["background-color", "border-color", "color"],
                    { duration: theme.transitions.duration.shortest }
                  ),
                  "& > span": {
                    gridArea: "1 / 1",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "3px",
                  },
                  "& svg": { fontSize: 14 },
                  [NARROW_CELL]: {
                    width: ACTION_HEIGHT,
                    padding: 0,
                    justifyItems: "center",
                    [`& .${WORD}`]: { display: "none" },
                  },
                }}
              >
                {active ? (
                  <>
                    <span className={SHOWING}>
                      <CheckRoundedIcon />
                      <span className={WORD}>Showing</span>
                    </span>
                    {clearable && (
                      <span className={CLEAR}>
                        <CloseRoundedIcon />
                        <span className={WORD}>Clear</span>
                      </span>
                    )}
                  </>
                ) : (
                  <span>
                    <span className={WORD}>Show</span>
                    <ArrowDownwardRoundedIcon />
                  </span>
                )}
              </Box>
            </ButtonBase>
          </Tooltip>
        );
      })}
    </Box>
  );
}
