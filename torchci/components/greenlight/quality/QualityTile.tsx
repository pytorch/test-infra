import { ButtonBase, Paper, Skeleton, Stack, Typography } from "@mui/material";
import { Theme } from "@mui/material/styles";
import { NO_DATA_IN_WINDOW } from "lib/greenlight/qualityFigures";
import { MouseEvent, ReactNode, useRef } from "react";
import InfoTooltip from "./InfoTooltip";

const TILE_MIN_HEIGHT = 128;
const VALUE_SKELETON_HEIGHT = 56;
const VALUE_FONT_SIZE = "1.75rem";
const CLICK_MAX_TRAVEL_PX = 5;

// One span for every tile on the page, which all sit in a single Grid container
// so they reflow as one run and pack as many per row as the width allows,
// instead of each panel holding a row of its own.
export const TILE_SPAN = { xs: 12, sm: 6, md: 4, lg: 3 };

export type TileToggleProps = {
  selected?: boolean;
  onToggle?: () => void;
  controlsId?: string;
};

// Where the mouse went down on a toggleable tile and what text was selected at
// that moment; the click that ends the press is judged against it.
export type TilePress = { x: number; y: number; selection: string };

function selectedText(): string {
  return window.getSelection()?.toString() ?? "";
}

// Clicks from a portal, such as the open tooltip, bubble here through React but
// are not inside the tile, and a click on the info affordance or any other
// button belongs to that button.
function isOnTileFace(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target as Element;
  return (
    event.currentTarget.contains(target) && target.closest("button") === null
  );
}

// Any other click on a toggleable tile opens or closes its chart, unless it is
// a later click of a double- or triple-click — dblclick owns the second toggle
// — or it ends a drag, so the figures stay selectable: the pointer travelled
// more than CLICK_MAX_TRAVEL_PX, or a non-empty selection changed during the
// press, as when a drag returns near its start or shift+click extends a
// selection. The selection alone cannot decide: Chromium keeps it through a
// click that began inside it, and that click toggles. A keyboard or
// assistive-technology click (detail 0) has no press to judge.
export function isToggleClick(
  event: MouseEvent<HTMLElement>,
  press: TilePress | undefined,
  selection: string
): boolean {
  if (event.detail > 1 || !isOnTileFace(event)) {
    return false;
  }
  if (event.detail === 0) {
    return true;
  }
  const travel =
    press === undefined
      ? 0
      : Math.hypot(event.clientX - press.x, event.clientY - press.y);
  return (
    travel <= CLICK_MAX_TRAVEL_PX &&
    (selection === "" || selection === (press?.selection ?? ""))
  );
}

// A double-click toggles once more, undoing its first click: selecting a word
// leaves the chart as it was, and two quick clicks on an open tile close and
// reopen it. The word is already selected when dblclick fires, so only the
// target is checked.
export function isToggleDoubleClick(event: MouseEvent<HTMLElement>): boolean {
  return isOnTileFace(event);
}

// Outlines only, never a fill: a tint behind the text would cut the contrast
// the figures' colours are measured against. Only an open chart's tile carries
// the primary colour, so a hovered tile never passes for a selected one.
function toggleSx(theme: Theme, selected: boolean) {
  return {
    position: "relative",
    cursor: "pointer",
    outline: selected
      ? `2px solid ${theme.palette.primary.main}`
      : "1px solid transparent",
    ...(selected
      ? {}
      : { "&:hover": { outlineColor: theme.palette.text.secondary } }),
  } as const;
}

// Every figure on this page needs a caveat, which ScalarPanelWithValue has no
// slot for, so the tile lives here once instead of being re-styled in each
// panel file.
//
// caveat and note are the tile's long prose and are reachable only through the
// header's info affordance. sub stays on the face: it carries whatever stops the
// value being misread — the n and the fractions it is computed from, the key to
// any colour it is encoded in — and none of that may be a hover away.
//
// onToggle makes the whole tile a disclosure for the chart controlsId names.
// The button that carries it for keyboards and screen readers lies over the tile
// without catching the pointer, so no interactive element nests inside another
// and the mouse reaches the text and the info affordance beneath it.
export default function QualityTile({
  label,
  value,
  sub,
  caveat,
  note,
  loading = false,
  empty = false,
  error,
  selected = false,
  onToggle,
  controlsId,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  caveat?: string;
  note?: string;
  loading?: boolean;
  empty?: boolean;
  error?: string;
} & TileToggleProps) {
  const press = useRef<TilePress | undefined>(undefined);

  // The prose interpolates the row's own counts, so it says nothing while the
  // row is absent. Shown on exactly the states that show a value.
  const showProse = !loading && error === undefined && !empty;

  const toggleHandlers =
    onToggle === undefined
      ? {}
      : {
          onMouseDown: (event: MouseEvent<HTMLElement>) => {
            press.current = {
              x: event.clientX,
              y: event.clientY,
              selection: selectedText(),
            };
          },
          onClick: (event: MouseEvent<HTMLElement>) => {
            const toggles = isToggleClick(event, press.current, selectedText());
            // A press belongs to the one click that ends it.
            press.current = undefined;
            if (toggles) {
              onToggle();
            }
          },
          onDoubleClick: (event: MouseEvent<HTMLElement>) => {
            if (isToggleDoubleClick(event)) {
              onToggle();
            }
          },
        };

  return (
    <Paper
      elevation={3}
      {...toggleHandlers}
      sx={(theme) => ({
        p: 2,
        height: "100%",
        minHeight: TILE_MIN_HEIGHT,
        display: "flex",
        flexDirection: "column",
        ...(onToggle === undefined ? {} : toggleSx(theme, selected)),
      })}
    >
      {onToggle !== undefined && (
        <ButtonBase
          aria-label={`${label} chart`}
          aria-expanded={selected}
          // The chart is unmounted while closed, and aria-controls must name an
          // element that exists.
          aria-controls={selected ? controlsId : undefined}
          onClick={onToggle}
          disableRipple
          // MUI resets the outline and draws no ripple for keyboard focus here,
          // so without this the focused tile would look like every other one.
          // Dashed and set off the tile's edge, the ring never reads as the
          // selected outline.
          sx={(theme) => ({
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            borderRadius: "inherit",
            "&.Mui-focusVisible": {
              outline: `2px dashed ${theme.palette.text.primary}`,
              outlineOffset: 4,
            },
          })}
        />
      )}

      <Stack direction="row" alignItems="center" spacing={0.5}>
        <Typography variant="subtitle2" color="text.secondary">
          {label}
        </Typography>
        {showProse && <InfoTooltip label={label} paragraphs={[caveat, note]} />}
      </Stack>

      {loading && (
        <Skeleton
          variant="rectangular"
          height={VALUE_SKELETON_HEIGHT}
          sx={{ mt: 1 }}
        />
      )}

      {!loading && error !== undefined && (
        <Typography variant="body2" color="error.main" sx={{ mt: 1 }}>
          {error}
        </Typography>
      )}

      {!loading && error === undefined && empty && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {NO_DATA_IN_WINDOW}
        </Typography>
      )}

      {showProse && (
        <>
          <Typography
            component="div"
            color="text.primary"
            sx={{
              mt: 0.5,
              lineHeight: 1.2,
              fontSize: VALUE_FONT_SIZE,
            }}
          >
            {value}
          </Typography>
          {sub !== undefined && (
            <Typography variant="body2" color="text.primary" sx={{ mt: 0.5 }}>
              {sub}
            </Typography>
          )}
        </>
      )}
    </Paper>
  );
}
