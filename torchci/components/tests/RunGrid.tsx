import {
  Box,
  LinearProgress,
  Paper,
  Skeleton,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import HeaderCheck from "components/tests/HeaderCheck";
import {
  HEADER_FILTER_INSET,
  HEADER_FILTER_SIZE,
} from "components/tests/HeaderFilter";
import HeaderSearch from "components/tests/HeaderSearch";
import HeaderSelect from "components/tests/HeaderSelect";
import LoadError from "components/tests/LoadError";
import LoadTime from "components/tests/LoadTime";
import dayjs from "dayjs";
import type { TestOptions } from "lib/api/tests/options/types";
import type { HealthWindow, RanOn } from "lib/api/tests/parameters";
import type {
  RunGridCell,
  RunGrid as RunGridData,
  RunOutcome,
} from "lib/api/tests/test/runs/types";
import { environmentDetails, variableLines } from "lib/tests/environment";
import { labelOf } from "lib/tests/facets";
import {
  allOutcomesShown,
  attemptStatus,
  badgeLabel,
  cardJobs,
  CELL_EDGE,
  CELL_HOVER_GROWTH,
  CELL_STATUSES,
  cellHeadline,
  CellPart,
  cellParts,
  cellRadius,
  cellStatus,
  CellStatus,
  cellTime,
  changeLabel,
  columnCommits,
  columnLayout,
  commitSearch,
  commitSearchMessage,
  COUNT_COLUMNS,
  dayMarks,
  decisiveJob,
  DEFAULT_GRID_TIME_BAR,
  DEFAULT_TYPICAL_FIGURE_WIDTH,
  edgedBox,
  estimatedBadgeWidth,
  estimatedLabelWidth,
  estimatedTextWidth,
  filterGroups,
  foldedLaneHeight,
  footerHeight,
  GRID_SIZES,
  gridColumns,
  gridGroups,
  GridLaneRow,
  GridQuery,
  gridRows,
  headerDescriptions,
  LABEL_AIR,
  LABEL_SEPARATOR,
  labelLayout,
  laneTimes,
  LaneTimes,
  OUTCOME_LABELS,
  OUTCOME_WORDS,
  outcomesLabel,
  outcomesPhrase,
  outcomeSwatchStatus,
  panelPath,
  passedEventually,
  Stretch,
  stretchAtColumn,
  stretchLabel,
  stretchTone,
  timeBarAvailable,
  timeBarShown,
} from "lib/tests/grid";
import {
  attemptPillColors,
  badgeColors,
  cellFill,
  cellHoverColors,
  cellStroke,
  commitPillColors,
  hoverBandColor,
  pinnedCommitColors,
  stretchColors,
  typicalBarColor,
  weekendBandColor,
} from "lib/tests/gridColors";
import { MONOSPACE_FONT_FAMILY } from "lib/tests/header";
import { headerBandColor, headerRuleColor } from "lib/tests/headerColors";
import {
  HEADER_TITLE_STYLE,
  HEADER_TITLE_TOOLTIP_DELAY_MS,
  TABLE_BORDER,
} from "lib/tests/layout";
import { durationLabel, integerLabel } from "lib/tests/table";
import type { PageTiming } from "lib/tests/useTestsListing";
import {
  Fragment,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface RunGridProps {
  // The grid shown: while new choices load, the one shown last.
  grid: RunGridData | undefined;
  // A grid is on its way: the progress bar runs under the header, over the
  // grid shown last, or over the skeleton before any has arrived.
  loading: boolean;
  // How long the grid shown took to arrive, for the caption under the
  // table; null while one is on its way.
  timing: PageTiming | null;
  error: unknown;
  onRetry: () => void;
  // The choices on offer, from GET /api/tests/options; undefined until it
  // answers.
  options: TestOptions | undefined;
  // The URL's query resolved against the options; undefined with them.
  query: GridQuery | undefined;
  onQueryChange: (_query: GridQuery) => void;
}

// A day's span must hold its label, "Wed, Oct 28" at the caption size.
const DAY_LABEL_MIN_WIDTH = 72;
// The drawn shapes, bands, lines, cells and swatches, take no pointer
// events: the SVG reads the pointer by its coordinates, so a press on a
// band starts a text selection as a press on the page does, and the texts
// alone keep the pointer for their tooltips.
const SHAPE_STYLE = { pointerEvents: "none" } as const;
// About what the body takes for this test on a wide window, so the page
// does not jump when the grid replaces the skeleton.
const SKELETON_HEIGHT = 300;
// The row the pointer is over, the column, and which part of the row: its
// pills, or the band its time bar runs in.
interface Hover {
  column: number;
  laneIndex: number | null;
  part: "pills" | "bar";
}

// The ring around the cell under the pointer, the list's health blocks'
// hover ring, drawn inside the grown box as the cells' edge is.
const HOVER_RING = 1.5;
// The card and the pill are placed by measures read from the drawing, so
// the layout effect; on the server, where there is nothing to measure and a
// layout effect only warns, a plain effect (MUI's useEnhancedEffect).
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

function formatWhen(iso: string): string {
  return dayjs(iso).format("MMM D, h:mm A");
}

// A run's attempts on the card as a row of pills, each the word of its
// outcome in its status's colors, an arrow from one to the next: "Crashed →
// Passed".
function AttemptPills({
  attempts,
  theme,
}: {
  attempts: readonly RunOutcome[];
  theme: Theme;
}) {
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 0.5,
      }}
    >
      {attempts.map((outcome, index) => {
        const colors = attemptPillColors(theme, attemptStatus(outcome));
        return (
          <Fragment key={index}>
            {index > 0 && (
              <Box component="span" sx={{ color: "text.disabled" }}>
                →
              </Box>
            )}
            <Box
              component="span"
              sx={{
                px: 0.75,
                borderRadius: 999,
                backgroundColor: colors.background,
                color: colors.text,
                fontWeight: 500,
                lineHeight: 1.6,
              }}
            >
              {OUTCOME_WORDS[outcome]}
            </Box>
          </Fragment>
        );
      })}
    </Box>
  );
}

// A configuration's lines on a card: its workflow and label, the muted
// second line, and its variables one a line, as the list page's Config
// tooltip lists them.
function LaneCardLines({ row }: { row: GridLaneRow }) {
  return (
    <>
      <Box sx={{ color: "text.secondary" }}>
        {row.group.name} · {row.lane.tokens.join(LABEL_SEPARATOR)}
      </Box>
      {row.lane.details.length > 0 && (
        <Box sx={{ color: "text.disabled" }}>
          {row.lane.details.join(LABEL_SEPARATOR)}
        </Box>
      )}
      {row.lane.variables.length > 0 && (
        <Box
          sx={{
            whiteSpace: "pre-wrap",
            fontFamily: MONOSPACE_FONT_FAMILY,
            color: "text.secondary",
          }}
        >
          {row.lane.variables.join("\n")}
        </Box>
      )}
    </>
  );
}

// What the pointer is over, read from the plot's own coordinates: the plot
// scrolls as a whole, so its left edge is the first column's wherever it
// stands.
function hoverAt(
  event: ReactMouseEvent<SVGSVGElement>,
  step: number,
  columns: number,
  laneRows: GridLaneRow[]
): Hover | null {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (x < 0 || step === 0) return null;
  const column = Math.floor(x / step);
  if (column < 0 || column >= columns) return null;
  const laneIndex = laneRows.findIndex(
    (row) => y >= row.top && y < row.top + row.height
  );
  if (laneIndex === -1) return { column, laneIndex: null, part: "pills" };
  const intoLane = y - laneRows[laneIndex].top;
  const onBar =
    intoLane >= GRID_SIZES.timeBarTop &&
    intoLane < GRID_SIZES.timeBarTop + GRID_SIZES.timeBarHeight;
  return { column, laneIndex, part: onBar ? "bar" : "pills" };
}

// A column's title on the header band, as the list table sets its own:
// small, bold, uppercase and muted, at the table's own font size, with the
// column's one explanation as its tooltip when it needs one.
function HeaderTitle({
  children,
  sx,
  title,
}: {
  children: ReactNode;
  sx: SxProps<Theme>;
  title?: string;
}) {
  const text = (
    <Typography
      variant="body2"
      component="span"
      sx={[
        {
          position: "absolute",
          top: "50%",
          ...HEADER_TITLE_STYLE,
          color: "text.secondary",
          whiteSpace: "nowrap",
          lineHeight: 1,
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {children}
    </Typography>
  );
  // The help keeps its line breaks: a legend line per color.
  return title === undefined ? (
    text
  ) : (
    <Tooltip
      title={title}
      enterDelay={HEADER_TITLE_TOOLTIP_DELAY_MS}
      slotProps={{ tooltip: { sx: { whiteSpace: "pre-line" } } }}
    >
      {text}
    </Tooltip>
  );
}

// A swatch of a status, as the card shows it: a cell, fill and edge.
function Swatch({ theme, status }: { theme: Theme; status: CellStatus }) {
  return (
    <Box
      component="span"
      aria-hidden
      sx={{
        flex: "none",
        boxSizing: "border-box",
        width: GRID_SIZES.swatchWidth,
        height: GRID_SIZES.cellHeight,
        borderRadius: "999px",
        backgroundColor: cellFill(theme, status),
        border: `${CELL_EDGE}px solid ${cellStroke(theme, status)}`,
      }}
    />
  );
}

// The grid of a test's runs: one row per workflow configuration, grouped
// under the workflow's file, one column per commit the test ran on, the
// newest at the left beside the counts, every
// attempt of a configuration on a commit folded into one cell colored by
// how it ended. A cell is never narrower than MIN_CELL_WIDTH: when the
// commits outnumber the room the plot grows past it and scrolls sideways
// under the fixed label and Outcomes columns, its scrollbar in the footer
// strip, the newest commits in view at first (columnLayout; fitted to the
// room, a pull request week's 1,400 commits drew nothing). A grid rather
// than a chart: it has no bucket to choose,
// aligns the workflows on the commits they share, and makes the lanes that
// only skip visible as faint rows instead of a sentence.
//
// It is set as a table in the list table's frame: HUD's shared border
// around rounded corners, a header band in the same grey with small bold
// uppercase muted titles and a short rule between its columns, hairlines
// between rows. The band's right end holds the table's choices as keys in
// the headers' filter-key style: a commit to find, the code source, the
// window, the outcomes shown and the time bar. Each
// workflow is a section: a row in the band's grey with its name in mono,
// its configurations beneath in the caption size, a skip-only lane muted;
// beside each lane its passed, failed and skipped cells
// are counted in one Outcomes column, three fixed slots each led by a
// swatch in the color of the cells it counts, a zero left blank, so the
// figures align down the column and the swatches say what the colors mean
//. A lane's label is its config
// and environment on two lines, as the list page's Config and Environment
// cells set them. Under a lane's counts, on the Outcomes column's second
// line, the median time of the lane's passing cells, the grid's own figure
// and not the list's Mean Passed Duration, and a bar after it that is its
// share of the slowest configuration's. A lane's
// variables besides the config are counted in a badge at the label
// column's right edge, "+3 vars", as the list page's Config cell counts
// them; a click on it opens the badge into a panel under the label that
// lists them in full, "PYTORCH_TEST_WITH_SLOW=1", one a line, the lane
// growing downward for it, and another click folds it. With the
// time bar on, a checkbox key in the header that the pull request view
// unticks and disables (timeBarAvailable: pull requests are no one line of
// commits for a stretch to run along), a
// configuration with passes is a taller lane: its pills on an upper row
// and under them its time bar, the stretches of one typical time as blocks
// labelled with that time, a later stretch opening with its change on the
// one before, grey at the oldest stretch's time, red when slower, green
// when faster. Hovering a column bands it
// across every lane and names the commit in the footer; hovering a cell
// grows it and rings it in its hue's deeper shade, as the list's health
// blocks ring themselves, and tells its story in a card; a click opens the
// job on GitHub. Days are
// marked by a hairline and a label in the footer, a band in the header's
// grey, weekends by a faint band. Everything is drawn in SVG from
// lib/tests/grid.ts's decisions, the header and the overlays in HTML over
// it.
export default function RunGrid({
  grid,
  loading,
  timing,
  error,
  onRetry,
  options,
  query,
  onQueryChange,
}: RunGridProps) {
  const theme = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const pinnedPillRef = useRef<HTMLDivElement>(null);
  // The plot's scroller and the footer's, which scroll as one, and how far
  // they are scrolled, for the overlays placed over the plot and the
  // columns drawn.
  const plotScrollerRef = useRef<HTMLDivElement>(null);
  const footerScrollerRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [width, setWidth] = useState(0);
  const [measuredLabelWidth, setMeasuredLabelWidth] = useState<number>();
  // The lanes whose variables the reader has expanded, by key.
  const [expandedLanes, setExpandedLanes] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const toggleLane = (key: string) =>
    setExpandedLanes((lanes) => {
      const next = new Set(lanes);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const [hover, setHover] = useState<Hover | null>(null);
  const [overlay, setOverlay] = useState({
    tooltip: 0,
    tooltipHeight: 0,
    pill: 0,
    pinned: 0,
    // Where the drawing's top stands in the viewport, so the card can tell
    // whether it would climb under the header stuck to the viewport's top.
    svgTop: 0,
  });

  // The lanes, narrowed to the outcomes shown; every outcome until the
  // choices are known.
  const shownOutcomes = query?.outcomes ?? CELL_STATUSES;
  const narrowed = !allOutcomesShown(shownOutcomes);
  const groups = useMemo(
    () =>
      grid === undefined
        ? []
        : filterGroups(gridGroups(grid, options), shownOutcomes),
    [grid, options, shownOutcomes]
  );
  // Whether the time bar runs under the pills: the reader's choice, off in
  // the pull request view; the time line under the counts stays either way.
  const timeBar =
    query === undefined ? DEFAULT_GRID_TIME_BAR : timeBarShown(query);
  // The columns: the commits newest first, so the latest runs stand beside
  // the counts.
  const commits = useMemo(
    () => (grid === undefined ? [] : columnCommits(grid)),
    [grid]
  );
  const marks = useMemo(() => dayMarks(commits), [commits]);
  const {
    sections,
    lanes: laneRows,
    bottom,
  } = useMemo(() => gridRows(groups, expandedLanes), [groups, expandedLanes]);
  // Each configuration's times by its lane's key, and the slowest
  // configuration's typical time, which the bars are drawn against.
  const timesByLane = useMemo(
    () =>
      new Map(
        laneRows.map((row) => [row.lane.key, laneTimes(row.lane, commits)])
      ),
    [laneRows, commits]
  );
  const slowestTypical = Math.max(
    0,
    ...[...timesByLane.values()].map((times) => times.typical ?? 0)
  );
  // The label column is as wide as its widest label line, the badge's room
  // counted on the line it shares, or its widest expanded variable in its
  // panel; estimated until measured.
  const widestRow = Math.max(
    0,
    ...laneRows.map((row) => {
      const badgeRoom =
        row.lane.variables.length > 0
          ? GRID_SIZES.badgeGap + estimatedBadgeWidth(row.lane.variables.length)
          : 0;
      const first = estimatedTextWidth(row.lane.tokens.join(LABEL_SEPARATOR));
      const second =
        row.lane.details.length > 0
          ? estimatedTextWidth(row.lane.details.join(LABEL_SEPARATOR))
          : null;
      return Math.max(
        second === null ? first + badgeRoom : first,
        second === null ? 0 : second + badgeRoom,
        ...(expandedLanes.has(row.lane.key)
          ? row.lane.variables.map(
              (variable) =>
                estimatedTextWidth(variable) + 2 * GRID_SIZES.panelPadding
            )
          : [])
      );
    })
  );
  const labelWidth = measuredLabelWidth ?? estimatedLabelWidth(widestRow);
  // The typical time figures' slot is as wide as the widest of them.
  const typicalFigureWidth = Math.max(
    0,
    ...[...timesByLane.values()].map((times) =>
      times.typical === null
        ? 0
        : estimatedTextWidth(durationLabel(times.typical))
    )
  );
  const {
    outcomes,
    typicalFigureX,
    typicalBarX,
    typicalBarWidth,
    rules,
    plotX,
  } = gridColumns(
    labelWidth,
    timesByLane.size === 0 ? DEFAULT_TYPICAL_FIGURE_WIDTH : typicalFigureWidth
  );
  // The plot's room after the fixed columns, and its width: the room when
  // the commits fit it, else wider, scrolling under the fixed columns.
  const room = Math.max(0, width - plotX);
  const { step, gap, cellWidth, plotWidth } = columnLayout(
    commits.length,
    room
  );
  const scrollable = plotWidth > room;
  // A column's left edge in the plot's own coordinates.
  const x = (column: number) => Math.round(column * step);
  // Where a point of the plot stands in the table while the plot is
  // scrolled, for the card and the footer's pills.
  const viewX = (plot: number) => plotX + plot - scrollLeft;
  // The columns in view, a couple over at each end for the pointer's grown
  // cell: the only ones whose pills are drawn, since a pull request week's
  // 1,400 columns over 16 lanes would be some 23,000 pills redrawn at
  // every move of the pointer.
  const drawn =
    step === 0
      ? { from: 0, to: 0 }
      : {
          from: Math.max(0, Math.floor(scrollLeft / step) - 2),
          to: Math.min(
            commits.length,
            Math.ceil((scrollLeft + room) / step) + 2
          ),
        };

  // The table is as wide as its column, and follows the window.
  useIsomorphicLayoutEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const update = () => setWidth(element.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The label column is as wide as its widest label line once the browser
  // has set them, a first line with its badge's room after it or an
  // expanded variable, so no label runs into the counts; estimated until
  // then. The width is a dependency because the drawing exists only once
  // it is known: a grid already in the cache at mount would otherwise never
  // be measured.
  useIsomorphicLayoutEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    let longest = 0;
    svg
      .querySelectorAll<SVGTextElement>("text[data-lane-label]")
      .forEach((text) => {
        longest = Math.max(
          longest,
          text.getComputedTextLength() + Number(text.dataset.allowance ?? 0)
        );
      });
    const wanted = Math.ceil(longest) + GRID_SIZES.laneIndent + LABEL_AIR;
    if (longest > 0 && Math.abs(wanted - labelWidth) > 1) {
      setMeasuredLabelWidth(wanted);
    }
  }, [groups, labelWidth, expandedLanes, width]);

  // The card and the pill are placed by their size, read once drawn, and
  // by where the drawing stands in the viewport.
  useIsomorphicLayoutEffect(() => {
    const tooltip = tooltipRef.current?.offsetWidth ?? 0;
    const tooltipHeight = tooltipRef.current?.offsetHeight ?? 0;
    const pill = pillRef.current?.offsetWidth ?? 0;
    const pinned = pinnedPillRef.current?.offsetWidth ?? 0;
    const svgTop = svgRef.current?.getBoundingClientRect().top ?? 0;
    if (
      tooltip !== overlay.tooltip ||
      tooltipHeight !== overlay.tooltipHeight ||
      pill !== overlay.pill ||
      pinned !== overlay.pinned ||
      svgTop !== overlay.svgTop
    ) {
      setOverlay({ tooltip, tooltipHeight, pill, pinned, svgTop });
    }
  }, [hover, overlay, query]);

  // The pointer may still stand where a lane or a column of the grid shown
  // last was when a new grid takes its place; nothing is over it then.
  const hoveredRow =
    hover === null || hover.laneIndex === null
      ? null
      : laneRows[hover.laneIndex] ?? null;
  const hoveredCommit = hover === null ? null : commits[hover.column] ?? null;
  const hoveredCell: RunGridCell | undefined =
    hoveredRow === null || hoveredCommit === null
      ? undefined
      : hoveredRow.lane.cells.get(hoveredCommit.sha);
  // The job a click opens: the one that decided the cell under the pointer.
  const hoveredJobUrl =
    hoveredCell === undefined ? null : decisiveJob(hoveredCell).job_url;
  // The stretch under the pointer when it stands on a lane's time bar: the
  // block covering the column, the columns between its passes included.
  // It takes the card and the outline then, and a click opens no job.
  const barStretchOf = (at: Hover | null): Stretch | null => {
    if (!timeBar || at === null || at.part !== "bar" || at.laneIndex === null) {
      return null;
    }
    const row = laneRows[at.laneIndex];
    if (row === undefined) return null;
    const times = timesByLane.get(row.lane.key);
    return times === undefined ? null : stretchAtColumn(times, at.column);
  };
  const barStretch = barStretchOf(hover);
  // Where a lane's pills sit: on the upper row of a lane with a time bar,
  // in the middle of one without; an expanded lane grows under them.
  const pillMiddleOf = (row: GridLaneRow) =>
    timeBar && (timesByLane.get(row.lane.key)?.stretches.length ?? 0) > 0
      ? row.top + GRID_SIZES.pillRowCenter
      : row.top + foldedLaneHeight(row.lane) / 2;
  // A stretch's block across the plot: from its newest pass's column, at
  // the left, to its oldest's, a hairline in from the older block to its
  // right, and at least a stub wide, the stub reaching rightward over the
  // older block, which is drawn over it.
  const stretchExtent = (times: LaneTimes, position: number) => {
    const stretch = times.stretches[position];
    const left = x(times.columns[stretch.to - 1]);
    const right = Math.max(
      x(times.columns[stretch.from]) + cellWidth - (position === 0 ? 0 : 1),
      left + GRID_SIZES.stretchMinWidth
    );
    return { left, right };
  };
  // The stretch of the time bar the hovered pass lies in, for the card.
  const hoveredStretch = (() => {
    if (
      !timeBar ||
      hover === null ||
      hoveredRow === null ||
      hoveredCell === undefined ||
      !passedEventually(hoveredCell)
    ) {
      return null;
    }
    const times = timesByLane.get(hoveredRow.lane.key);
    if (times === undefined) return null;
    const position = times.columns.indexOf(hover.column);
    return (
      times.stretches.find(
        (stretch) => position >= stretch.from && position < stretch.to
      ) ?? null
    );
  })();
  const captionSize = theme.typography.caption.fontSize;
  const bodySize = theme.typography.body2.fontSize;
  const fontFamily = theme.typography.fontFamily;
  const hairline = theme.palette.divider;
  const band = headerBandColor(theme);
  const pill = commitPillColors(theme);
  const pinned = pinnedCommitColors(theme);
  const badge = badgeColors(theme);
  const choices =
    options !== undefined && query !== undefined ? { options, query } : null;
  // The commit the header's search field names: its column is banded and
  // its pill pinned in the footer; a hash that names no column is told so
  // under the field once the grid is here to say.
  const commitText = choices === null ? "" : choices.query.commit;
  const search = commitSearch(commits, commitText);
  // The column headers' hover help, the window named as the key shows it.
  const descriptions = headerDescriptions(
    choices === null
      ? undefined
      : labelOf(choices.query.window, choices.options.window.values),
    timeBar
  );
  const searchMessage = (() => {
    if (grid === undefined || choices === null) return null;
    const text = commitSearchMessage(
      search,
      commitText,
      labelOf(choices.query.ranOn, choices.options.ran_on.values),
      `last ${labelOf(choices.query.window, choices.options.window.values)}`
    );
    return text === null
      ? null
      : {
          text,
          tone:
            search.kind === "several" ? ("note" as const) : ("error" as const),
        };
  })();
  const pinnedColumn = search.kind === "found" ? search.column : null;
  const pinnedCommit =
    pinnedColumn === null ? null : commits[pinnedColumn] ?? null;
  // The plot and the footer's day labels scroll as one: moving either
  // scroller moves the other, and the offset is kept for the overlays and
  // the columns drawn.
  const syncScroll = (source: HTMLDivElement, other: HTMLDivElement | null) => {
    const left = source.scrollLeft;
    if (other !== null && other.scrollLeft !== left) other.scrollLeft = left;
    setScrollLeft((current) => (current === left ? current : left));
  };
  // New choices of code source or window start at the plot's left end,
  // the newest commits.
  const ranOn = query?.ranOn;
  const windowChoice = query?.window;
  useEffect(() => {
    const scroller = plotScrollerRef.current;
    if (scroller !== null) scroller.scrollLeft = 0;
  }, [ranOn, windowChoice]);
  // The commit the search found is brought into view, centred in the room.
  useEffect(() => {
    const scroller = plotScrollerRef.current;
    if (scroller === null || pinnedColumn === null) return;
    scroller.scrollLeft = Math.max(
      0,
      Math.round(pinnedColumn * step) + cellWidth / 2 - room / 2
    );
  }, [pinnedColumn, step, cellWidth, room]);
  // The frame's corners, and the band's inside them.
  const radius = Number(theme.shape.borderRadius);

  const handleMove = (event: ReactMouseEvent<SVGSVGElement>) => {
    const next = hoverAt(event, step, commits.length, laneRows);
    if (
      (next === null) !== (hover === null) ||
      (next !== null &&
        hover !== null &&
        (next.column !== hover.column ||
          next.laneIndex !== hover.laneIndex ||
          next.part !== hover.part))
    ) {
      setHover(next);
    }
  };
  const handleFooterMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    // Into the plot, which scrolls under the strip's fixed left part.
    const across = event.clientX - rect.left - plotX + scrollLeft;
    const column = step === 0 ? -1 : Math.floor(across / step);
    const next: Hover | null =
      across < 0 || column < 0 || column >= commits.length
        ? null
        : { column, laneIndex: null, part: "pills" };
    if (
      (next === null) !== (hover === null) ||
      (next !== null &&
        hover !== null &&
        (next.column !== hover.column ||
          hover.laneIndex !== null ||
          hover.part !== "pills"))
    ) {
      setHover(next);
    }
  };
  const handleClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    const at = hoverAt(event, step, commits.length, laneRows);
    if (at === null || at.laneIndex === null || barStretchOf(at) !== null) {
      return;
    }
    const cell = laneRows[at.laneIndex].lane.cells.get(commits[at.column].sha);
    const url = cell === undefined ? null : decisiveJob(cell).job_url;
    if (url) window.open(url, "_blank", "noopener");
  };

  const cellCenter =
    hover === null ? 0 : viewX(x(hover.column) + cellWidth / 2);
  const clamp = (value: number, size: number) =>
    Math.max(plotX + size / 2, Math.min(width - size / 2, value));

  // What stands under the header: the error, the skeleton before any grid
  // has arrived, the empty sentence, or the rows, the grid shown last while
  // a new one loads.
  let body: ReactNode;
  if (error !== undefined) {
    body = (
      <Box sx={{ p: 2 }}>
        <LoadError what="the runs" error={error} onRetry={onRetry} />
      </Box>
    );
  } else if (grid === undefined) {
    body = <Skeleton variant="rectangular" height={SKELETON_HEIGHT} />;
  } else if (groups.length === 0) {
    body = (
      <Typography variant="body2" sx={{ color: "text.secondary", p: 2 }}>
        {choices === null
          ? "No runs."
          : `No ${
              narrowed ? `${outcomesPhrase(shownOutcomes)} ` : ""
            }runs on ${labelOf(
              choices.query.ranOn,
              choices.options.ran_on.values
            )} in the last ${labelOf(
              choices.query.window,
              choices.options.window.values
            )}.`}
      </Typography>
    );
  } else {
    body = (
      // The card is placed in the drawing's own coordinates. Under the
      // drawing, its own strip, the footer: the day labels and the commit
      // pills, stuck to the viewport's bottom while the drawing runs on
      // below it, as the header band is stuck to the top (a tall grid
      // would otherwise scroll both out of sight).
      <>
        <Box sx={{ position: "relative" }}>
          {width > 0 && (
            <Box sx={{ display: "flex", alignItems: "flex-start" }}>
              {/* The fixed columns: each workflow's name, its lanes' labels
              and badges and their outcomes, in one drawing; the plot beside
              them scrolls. */}
              <svg
                ref={svgRef}
                width={plotX}
                height={bottom}
                viewBox={`0 0 ${plotX} ${bottom}`}
                role="group"
                aria-label={`${integerLabel(
                  laneRows.length
                )} configurations down`}
                style={{ display: "block", flex: "none", fontFamily }}
              >
                {/* The badges' hover and focus, which the SVG's styles cannot
                say inline: a step darker under the pointer, the keys' ring
                when reached from the keyboard. */}
                <style>{`g[data-badge]:hover > rect { fill: ${badge.activeFill}; } g[data-badge]:focus-visible > rect[data-pill] { stroke: ${theme.palette.primary.main}; stroke-width: 2px; }`}</style>
                {/* Each workflow's row in the band's grey, continued in the
                plot. */}
                {sections.map((row) => (
                  <rect
                    key={row.group.workflowPath ?? ""}
                    x={0}
                    y={row.top}
                    width={plotX}
                    height={GRID_SIZES.sectionHeight}
                    fill={band}
                    style={SHAPE_STYLE}
                  />
                ))}
                {sections.map((row) => (
                  <text
                    key={row.group.workflowPath ?? ""}
                    x={GRID_SIZES.sectionIndent}
                    y={row.top + GRID_SIZES.sectionHeight / 2 + 4}
                    fill={theme.palette.text.primary}
                    style={{
                      fontSize: bodySize,
                      fontFamily: MONOSPACE_FONT_FAMILY,
                    }}
                  >
                    {row.group.workflowPath !== null && (
                      <title>{row.group.workflowPath}</title>
                    )}
                    {row.group.name}
                  </text>
                ))}
                {laneRows.map((row) => {
                  const { lane, group } = row;
                  const skipOnly = lane.status === "skipped";
                  // The middle of the lane folded, where its figures sit; an
                  // expanded lane grows under them, so nothing moves.
                  const middle = row.top + foldedLaneHeight(lane) / 2;
                  const lastOfSection =
                    group.lanes[group.lanes.length - 1] === lane;
                  // The configuration's times, for the median and its figure.
                  const times = timesByLane.get(lane.key);
                  // The Outcomes column's two lines when the configuration
                  // has a typical time: the counts on the first, the time on
                  // the second, as the label's lines sit; the counts alone in
                  // the lane's middle otherwise.
                  const typical = times === undefined ? null : times.typical;
                  const countBaseline =
                    typical === null ? middle + 4 : row.top + 17;
                  const timeBaseline = row.top + 31;
                  const details = [
                    ...(lane.environment === null
                      ? []
                      : environmentDetails(lane.environment).map(
                          (detail) => `${detail.name}: ${detail.value}`
                        )),
                    ...(lane.envVars === null
                      ? []
                      : variableLines(lane.envVars)),
                  ];
                  // The label: the config and the environment on two lines, as
                  // the list page's cells set them, a badge counting the
                  // variables at the column's right edge on the last line, and
                  // once the reader has expanded the lane, the badge opened
                  // into a panel under the label listing them.
                  const expanded = expandedLanes.has(lane.key);
                  const layout = labelLayout(row, lane, expanded);
                  const ink = skipOnly
                    ? theme.palette.text.disabled
                    : theme.palette.text.secondary;
                  const hasBadge = lane.variables.length > 0;
                  const open = expanded && hasBadge;
                  const badgeWidth = estimatedBadgeWidth(lane.variables.length);
                  const badgeLeft = labelWidth - LABEL_AIR - badgeWidth;
                  const badgeRoom = hasBadge
                    ? GRID_SIZES.badgeGap + badgeWidth
                    : 0;
                  const lastLine = layout.baselines.length - 1;
                  const panelLeft =
                    GRID_SIZES.laneIndent - GRID_SIZES.panelPadding;
                  const variableCount = `${lane.variables.length} variable${
                    lane.variables.length === 1 ? "" : "s"
                  } besides the config`;
                  return (
                    <g key={lane.key} data-lane>
                      <text
                        data-lane-label
                        data-allowance={lastLine === 0 ? badgeRoom : 0}
                        x={GRID_SIZES.laneIndent}
                        y={layout.baselines[0]}
                        fill={ink}
                        style={{ fontSize: captionSize }}
                      >
                        {details.length > 0 && (
                          <title>{details.join("\n")}</title>
                        )}
                        {lane.tokens.join(LABEL_SEPARATOR)}
                      </text>
                      {lane.details.length > 0 && (
                        <text
                          data-lane-label
                          data-allowance={badgeRoom}
                          x={GRID_SIZES.laneIndent}
                          y={layout.baselines[1]}
                          fill={theme.palette.text.disabled}
                          style={{ fontSize: captionSize }}
                        >
                          {lane.details.join(LABEL_SEPARATOR)}
                        </text>
                      )}
                      {/* The panel the badge opens into: the badge's grey from
                      the label's left edge to the badge's right, hanging
                      from the badge with its top-right corner square where
                      the tab meets it, the variables one a line inside. */}
                      {open && (
                        <>
                          <path
                            data-panel
                            d={panelPath(
                              {
                                x: panelLeft,
                                y: layout.panelTop,
                                width: badgeLeft + badgeWidth - panelLeft,
                                height: layout.panelHeight,
                              },
                              GRID_SIZES.badgeHeight / 2
                            )}
                            fill={badge.fill}
                            style={SHAPE_STYLE}
                          />
                          {lane.variables.map((variable, index) => (
                            <text
                              key={variable}
                              data-lane-label
                              data-allowance={2 * GRID_SIZES.panelPadding}
                              x={GRID_SIZES.laneIndent}
                              y={layout.variableBaselines[index]}
                              fill={ink}
                              style={{
                                fontSize: 11,
                                fontFamily: MONOSPACE_FONT_FAMILY,
                              }}
                            >
                              {variable}
                            </text>
                          ))}
                        </>
                      )}
                      {hasBadge && (
                        <g
                          data-badge
                          role="button"
                          tabIndex={0}
                          aria-expanded={expanded}
                          aria-label={`${variableCount}, ${
                            expanded ? "shown" : "hidden"
                          }`}
                          style={{ cursor: "pointer", outline: "none" }}
                          onClick={(event: ReactMouseEvent<SVGGElement>) => {
                            event.stopPropagation();
                            toggleLane(lane.key);
                          }}
                          onKeyDown={(
                            event: ReactKeyboardEvent<SVGGElement>
                          ) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              event.stopPropagation();
                              toggleLane(lane.key);
                            }
                          }}
                        >
                          <title>
                            {expanded
                              ? `Hide the ${variableCount}`
                              : `Show the ${variableCount}`}
                          </title>
                          {/* Open, the pill's lower half is squared into the
                          panel, so the two read as one tab and sheet. */}
                          {open && (
                            <rect
                              x={badgeLeft}
                              y={layout.badgeTop + GRID_SIZES.badgeHeight / 2}
                              width={badgeWidth}
                              height={GRID_SIZES.badgeHeight / 2}
                              fill={badge.fill}
                            />
                          )}
                          <rect
                            data-pill
                            x={badgeLeft}
                            y={layout.badgeTop}
                            width={badgeWidth}
                            height={GRID_SIZES.badgeHeight}
                            rx={GRID_SIZES.badgeHeight / 2}
                            fill={badge.fill}
                          />
                          <text
                            x={badgeLeft + badgeWidth / 2}
                            y={layout.badgeTop + GRID_SIZES.badgeHeight / 2 + 4}
                            textAnchor="middle"
                            fill={theme.palette.text.secondary}
                            style={{
                              fontSize: captionSize,
                              fontVariantNumeric: "tabular-nums",
                              pointerEvents: "none",
                            }}
                          >
                            {badgeLabel(lane.variables.length)}
                          </text>
                        </g>
                      )}
                      {/* The outcomes: a swatch and a figure in each slot with a
                      count, nothing in a slot without one; on the column's
                      first line when the typical time takes the second,
                      else in the lane's middle. */}
                      {COUNT_COLUMNS.map((column, index) => {
                        const count = lane[column];
                        if (count === 0) return null;
                        const swatchStatus = outcomeSwatchStatus(column, lane);
                        const swatch = edgedBox({
                          x: outcomes[index].swatchX,
                          y: countBaseline - 4 - GRID_SIZES.cellHeight / 2,
                          width: GRID_SIZES.swatchWidth,
                          height: GRID_SIZES.cellHeight,
                        });
                        return (
                          <g key={column}>
                            <rect
                              {...swatch}
                              rx={cellRadius(swatch.width, swatch.height)}
                              fill={cellFill(theme, swatchStatus)}
                              stroke={cellStroke(theme, swatchStatus)}
                              strokeWidth={CELL_EDGE}
                              style={SHAPE_STYLE}
                            />
                            <text
                              x={outcomes[index].figureX}
                              y={countBaseline}
                              fill={
                                skipOnly
                                  ? theme.palette.text.disabled
                                  : theme.palette.text.primary
                              }
                              style={{
                                fontSize: captionSize,
                                fontVariantNumeric: "tabular-nums",
                              }}
                            >
                              {integerLabel(count)}
                            </text>
                          </g>
                        );
                      })}
                      {/* The typical time of the configuration's passes on
                      the column's second line, under the first swatch, with
                      a bar after it that is its share of the slowest
                      configuration's; nothing when nothing passed. */}
                      {typical !== null && (
                        <>
                          {slowestTypical > 0 && typicalBarWidth > 0 && (
                            <rect
                              x={typicalBarX}
                              y={timeBaseline - 7}
                              width={Math.max(
                                1,
                                (typicalBarWidth * typical) / slowestTypical
                              )}
                              height={6}
                              rx={1.5}
                              fill={typicalBarColor(theme)}
                              style={SHAPE_STYLE}
                            />
                          )}
                          <text
                            x={typicalFigureX}
                            y={timeBaseline}
                            fill={theme.palette.text.primary}
                            style={{
                              fontSize: captionSize,
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {durationLabel(typical)}
                          </text>
                        </>
                      )}
                      {/* The hairline under the lane, continued in the plot;
                      the next section's band or the footer's rule bounds
                      the last lane of a section. */}
                      {!lastOfSection && (
                        <line
                          x1={0}
                          x2={plotX}
                          y1={row.top + row.height - 0.5}
                          y2={row.top + row.height - 0.5}
                          stroke={hairline}
                          style={SHAPE_STYLE}
                        />
                      )}
                    </g>
                  );
                })}
              </svg>
              {/* The plot: the runs on the commits, scrolling sideways under
              the fixed columns when the commits outnumber the room; its own
              scrollbar is hidden, the footer strip's showing for it. */}
              <Box
                ref={plotScrollerRef}
                onScroll={(event) =>
                  syncScroll(event.currentTarget, footerScrollerRef.current)
                }
                sx={{
                  flex: 1,
                  minWidth: 0,
                  overflowX: "auto",
                  overflowY: "hidden",
                  scrollbarWidth: "none",
                  "&::-webkit-scrollbar": { display: "none" },
                }}
              >
                {plotWidth > 0 && (
                  <svg
                    width={plotWidth}
                    height={bottom}
                    viewBox={`0 0 ${plotWidth} ${bottom}`}
                    role="group"
                    aria-label={`${integerLabel(
                      commits.length
                    )} commits across`}
                    style={{
                      display: "block",
                      fontFamily,
                      // The hand over a cell whose job can be opened; the
                      // shapes under the pointer set no cursor of their own.
                      cursor:
                        barStretch === null && hoveredJobUrl
                          ? "pointer"
                          : undefined,
                    }}
                    onMouseMove={handleMove}
                    onMouseLeave={() => setHover(null)}
                    onClick={handleClick}
                  >
                    {/* Each workflow's row in the band's grey, continued from
                    the fixed drawing. */}
                    {sections.map((row) => (
                      <rect
                        key={row.group.workflowPath ?? ""}
                        x={0}
                        y={row.top}
                        width={plotWidth}
                        height={GRID_SIZES.sectionHeight}
                        fill={band}
                        style={SHAPE_STYLE}
                      />
                    ))}
                    {/* Weekends and the hairline where the day changes; the day's
                label is in the footer strip under the drawing. */}
                    {marks.map((mark, index) => {
                      const start = x(mark.index) - gap / 2;
                      const next = marks[index + 1];
                      const end =
                        next === undefined
                          ? plotWidth
                          : x(next.index) - gap / 2;
                      return (
                        <g key={mark.index}>
                          {mark.weekend && (
                            <rect
                              x={start}
                              y={0}
                              width={end - start}
                              height={bottom}
                              fill={weekendBandColor(theme)}
                              style={SHAPE_STYLE}
                            />
                          )}
                          {mark.index > 0 && (
                            <line
                              x1={start}
                              x2={start}
                              y1={0}
                              y2={bottom}
                              stroke={hairline}
                              style={SHAPE_STYLE}
                            />
                          )}
                        </g>
                      );
                    })}
                    {hover !== null && (
                      <rect
                        x={x(hover.column) - gap / 2}
                        y={0}
                        width={cellWidth + gap}
                        height={bottom}
                        fill={hoverBandColor(theme)}
                        style={SHAPE_STYLE}
                      />
                    )}
                    {/* The column of the commit the search found, banded in the
                pinned orange, apart from the hover's blue. */}
                    {pinnedColumn !== null && (
                      <rect
                        x={x(pinnedColumn) - gap / 2}
                        y={0}
                        width={cellWidth + gap}
                        height={bottom}
                        fill={pinned.band}
                        style={SHAPE_STYLE}
                      />
                    )}
                    {laneRows.map((row) => {
                      const { lane, group } = row;
                      const cellHeight = GRID_SIZES.cellHeight;
                      // Where the lane's pills sit: on the upper row when a
                      // time bar runs under them, else in the lane's middle.
                      const pillMiddle = pillMiddleOf(row);
                      const lastOfSection =
                        group.lanes[group.lanes.length - 1] === lane;
                      // The stretches of the configuration's time bar.
                      const times = timesByLane.get(lane.key);
                      const timed =
                        timeBar &&
                        times !== undefined &&
                        times.stretches.length > 0;
                      return (
                        <g key={lane.key}>
                          {/* A pill for each run in view, in its status's colors;
                      a run whose first attempt ended differently from how
                      it ended is two capsules with a gap, the first
                      attempt's status above how the run ended (cellParts). */}
                          {commits
                            .slice(drawn.from, drawn.to)
                            .map((commit, index) => {
                              const column = drawn.from + index;
                              const cell = lane.cells.get(commit.sha);
                              if (cell === undefined) return null;
                              const parts = cellParts(cell, {
                                x: x(column),
                                y: pillMiddle - cellHeight / 2,
                                width: cellWidth,
                                height: cellHeight,
                              });
                              const pill = (
                                part: CellPart,
                                key: string | number
                              ) => {
                                const box = edgedBox(part.box);
                                return (
                                  <rect
                                    key={key}
                                    {...box}
                                    rx={cellRadius(box.width, box.height)}
                                    fill={cellFill(theme, part.status)}
                                    stroke={cellStroke(theme, part.status)}
                                    strokeWidth={CELL_EDGE}
                                    style={SHAPE_STYLE}
                                  />
                                );
                              };
                              return parts.length === 1 ? (
                                pill(parts[0], commit.sha)
                              ) : (
                                <g key={commit.sha}>
                                  {parts.map((part, index) =>
                                    pill(part, index)
                                  )}
                                </g>
                              );
                            })}
                          {/* The time bar: each stretch of the configuration's
                      passes a block from its newest pass's column to its
                      oldest's, the oldest stretch at the right end, tinted
                      against the oldest stretch's time and labelled with
                      its own; a newer stretch opens with its change on the
                      one before, the block to its right, the figure in the
                      tint's ink. A block too narrow for both shows its time
                      alone, a narrower one its change alone; one with no
                      room writes its label to its right when the room
                      before the older block allows, else nothing: the
                      pointer on any block brings the card with all of it.
                      The blocks are drawn newest first, so an older block
                      covers a stub's reach over it. */}
                          {timed &&
                            (() => {
                              const oldest = times.stretches[0].level;
                              const barTop = row.top + GRID_SIZES.timeBarTop;
                              const blocks = times.stretches.map(
                                (stretch, position) => {
                                  const { left, right } = stretchExtent(
                                    times,
                                    position
                                  );
                                  const colors = stretchColors(
                                    theme,
                                    stretchTone(stretch.level, oldest)
                                  );
                                  const level = durationLabel(stretch.level);
                                  const change =
                                    stretch.change === null
                                      ? null
                                      : changeLabel(stretch.change);
                                  const changeInk = stretchColors(
                                    theme,
                                    stretch.change !== null &&
                                      stretch.change > 0
                                      ? "slower"
                                      : "faster"
                                  ).text;
                                  const older = times.stretches[position - 1];
                                  // The label rides along inside a block scrolled
                                  // partly out of view, so a wide stretch keeps
                                  // its figure in sight.
                                  const labelLeft = Math.max(left, scrollLeft);
                                  const label = stretchLabel(
                                    { level, change },
                                    Math.min(right, scrollLeft + room) -
                                      labelLeft -
                                      12,
                                    (older === undefined
                                      ? plotWidth - 6
                                      : x(times.columns[older.to - 1])) -
                                      right -
                                      8
                                  );
                                  return (
                                    <g key={stretch.from}>
                                      <rect
                                        data-stretch
                                        x={left + 0.5}
                                        y={barTop + 0.5}
                                        width={Math.max(0, right - left - 1)}
                                        height={GRID_SIZES.timeBarHeight - 1}
                                        rx={3}
                                        fill={colors.fill}
                                        stroke={colors.edge}
                                        style={SHAPE_STYLE}
                                      />
                                      {label !== null && (
                                        <text
                                          x={
                                            label.outside
                                              ? right + 4
                                              : labelLeft + 6
                                          }
                                          y={
                                            barTop +
                                            GRID_SIZES.timeBarHeight / 2 +
                                            4
                                          }
                                          style={{
                                            fontSize: captionSize,
                                            fontVariantNumeric: "tabular-nums",
                                          }}
                                        >
                                          {change !== null &&
                                            label.form !== "level" && (
                                              <tspan
                                                fill={changeInk}
                                                fontWeight={600}
                                              >
                                                {change}
                                              </tspan>
                                            )}
                                          {label.form !== "change" && (
                                            <tspan fill={colors.text}>
                                              {change === null ||
                                              label.form === "level"
                                                ? level
                                                : ` \u00b7 ${level}`}
                                            </tspan>
                                          )}
                                        </text>
                                      )}
                                    </g>
                                  );
                                }
                              );
                              return blocks.reverse();
                            })()}
                          {/* The hairline under the lane, continued from the fixed
                      drawing; the next section's band or the footer's rule
                      bounds the last lane of a section. */}
                          {!lastOfSection && (
                            <line
                              x1={0}
                              x2={plotWidth}
                              y1={row.top + row.height - 0.5}
                              y2={row.top + row.height - 0.5}
                              stroke={hairline}
                              style={SHAPE_STYLE}
                            />
                          )}
                        </g>
                      );
                    })}
                    {/* The stretch under the pointer on a time bar, outlined in its
                ink over the rest, so its reach is seen whole. */}
                    {barStretch !== null &&
                      hoveredRow !== null &&
                      (() => {
                        const times = timesByLane.get(hoveredRow.lane.key);
                        if (times === undefined) return null;
                        const position = times.stretches.indexOf(barStretch);
                        const { left, right } = stretchExtent(times, position);
                        const tone = stretchTone(
                          barStretch.level,
                          times.stretches[0].level
                        );
                        return (
                          <rect
                            x={left + 0.5}
                            y={hoveredRow.top + GRID_SIZES.timeBarTop + 0.5}
                            width={Math.max(0, right - left - 1)}
                            height={GRID_SIZES.timeBarHeight - 1}
                            rx={3}
                            fill="none"
                            stroke={stretchColors(theme, tone).text}
                            strokeWidth={1.5}
                            style={SHAPE_STYLE}
                          />
                        );
                      })()}
                    {/* The cell under the pointer, grown and marked, over the rest. */}
                    {hover !== null &&
                      barStretch === null &&
                      hoveredRow !== null &&
                      hoveredCell !== undefined &&
                      (() => {
                        const grownHeight =
                          GRID_SIZES.cellHeight + 2 * CELL_HOVER_GROWTH;
                        const parts = cellParts(hoveredCell, {
                          x: x(hover.column) - CELL_HOVER_GROWTH,
                          y: pillMiddleOf(hoveredRow) - grownHeight / 2,
                          width: cellWidth + 2 * CELL_HOVER_GROWTH,
                          height: grownHeight,
                        });
                        return parts.map((part, index) => {
                          const box = edgedBox(part.box, HOVER_RING);
                          const colors = cellHoverColors(theme, part.status);
                          return (
                            <rect
                              key={index}
                              {...box}
                              rx={cellRadius(box.width, box.height)}
                              fill={colors.fill}
                              stroke={colors.stroke}
                              strokeWidth={HOVER_RING}
                              style={SHAPE_STYLE}
                            />
                          );
                        });
                      })()}
                  </svg>
                )}
              </Box>
            </Box>
          )}
          {hoveredRow !== null && hoveredCommit !== null && (
            <Paper
              ref={tooltipRef}
              elevation={6}
              sx={{
                position: "absolute",
                // Above the lane when the card fits over it within the body
                // and clear of the header stuck to the viewport's top (the
                // drawing's top in the viewport, measured with the card,
                // says where the body's coordinates stand), else beneath it.
                ...(hoveredRow.top - 10 - overlay.tooltipHeight >= 0 &&
                overlay.svgTop + hoveredRow.top - 10 - overlay.tooltipHeight >=
                  GRID_SIZES.headerHeight
                  ? {
                      top: hoveredRow.top - 10,
                      transform: "translate(-50%, -100%)",
                    }
                  : {
                      top: hoveredRow.top + hoveredRow.height + 10,
                      transform: "translateX(-50%)",
                    }),
                left: clamp(cellCenter, overlay.tooltip),
                pointerEvents: "none",
                p: 1.25,
                // Its content's width, wherever it stands, up to a readable line.
                width: "max-content",
                maxWidth: 480,
                fontSize: captionSize,
                lineHeight: 1.5,
                overflowWrap: "anywhere",
                // Over the header band and the footer strip, which are
                // stuck to the viewport's edges above the body.
                zIndex: 4,
              }}
            >
              {barStretch !== null ? (
                (() => {
                  // The stretch's card: its time and change, how many passes
                  // it spans and from when to when, then the configuration.
                  const times = timesByLane.get(hoveredRow.lane.key);
                  const first =
                    times === undefined
                      ? null
                      : commits[times.columns[barStretch.from]] ?? null;
                  const last =
                    times === undefined
                      ? null
                      : commits[times.columns[barStretch.to - 1]] ?? null;
                  const passes = barStretch.to - barStretch.from;
                  return (
                    <>
                      <Box sx={{ fontWeight: 500 }}>
                        Stretch at {durationLabel(barStretch.level)}
                        {barStretch.change !== null &&
                          ` · ${changeLabel(
                            barStretch.change
                          )} on the stretch before`}
                      </Box>
                      <Box sx={{ color: "text.secondary" }}>
                        {passes === 1
                          ? "1 pass"
                          : `${integerLabel(passes)} passes`}
                        {first !== null && ` · ${formatWhen(first.started_at)}`}
                        {last !== null &&
                          first !== last &&
                          ` – ${formatWhen(last.started_at)}`}
                      </Box>
                      <LaneCardLines row={hoveredRow} />
                    </>
                  );
                })()
              ) : hoveredCell === undefined ? (
                <Box sx={{ color: "text.secondary" }}>
                  {narrowed ? "No run shown" : "No run"} ·{" "}
                  {hoveredRow.group.name} ·{" "}
                  {hoveredRow.lane.tokens.join(LABEL_SEPARATOR)}
                </Box>
              ) : (
                <>
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      fontWeight: 500,
                    }}
                  >
                    <Swatch theme={theme} status={cellStatus(hoveredCell)} />
                    {cellHeadline(hoveredCell)} ·{" "}
                    {formatWhen(hoveredCell.started_at)}
                    {/* A pass is timed by the attempt that passed, the mean
                      over the jobs that passed, as the bar is; anything
                      else by the jobs that decided it. The whole spend, when
                      it is more, follows the jobs. */}
                    {hoveredCell.outcome !== "skipped" &&
                      ` · ${durationLabel(cellTime(hoveredCell))}`}
                  </Box>
                  {/* The stretch of the time bar a pass lies in. */}
                  {hoveredStretch !== null && (
                    <Box sx={{ color: "text.secondary" }}>
                      {hoveredStretch.change === null
                        ? `In the oldest stretch, at ${durationLabel(
                            hoveredStretch.level
                          )}`
                        : `In a stretch at ${durationLabel(
                            hoveredStretch.level
                          )}, ${changeLabel(
                            hoveredStretch.change
                          )} on the stretch before`}
                    </Box>
                  )}
                  <LaneCardLines row={hoveredRow} />
                  {/* Each job's attempts as pills with arrows between them,
                    under the job's name, the jobs that decided the cell
                    first: a sibling shard's run is its own line, not a
                    rerun of the first. A job that executed anything gives
                    its time, and the whole spend follows when it is more
                    than the headline's. */}
                  {cardJobs(hoveredCell).map((job) => (
                    <Box
                      key={job.job_id}
                      sx={{ color: "text.secondary", mt: 0.25 }}
                    >
                      {(job.job_name !== null ||
                        hoveredCell.jobs.length > 1) && (
                        <Box>{job.job_name ?? "Unknown job"}</Box>
                      )}
                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          flexWrap: "wrap",
                          gap: 0.5,
                        }}
                      >
                        <AttemptPills attempts={job.attempts} theme={theme} />
                        {job.duration_milliseconds > 0 && (
                          <Box component="span">
                            · {durationLabel(job.duration_milliseconds)}
                          </Box>
                        )}
                      </Box>
                    </Box>
                  ))}
                  {hoveredCell.duration_milliseconds >
                    cellTime(hoveredCell) && (
                    <Box sx={{ color: "text.secondary", mt: 0.25 }}>
                      {durationLabel(hoveredCell.duration_milliseconds)} in all
                    </Box>
                  )}
                  {hoveredJobUrl !== null && (
                    <Box sx={{ color: "text.disabled", mt: 0.5 }}>
                      {hoveredCell.jobs.length > 1
                        ? "Click to open the job that decided it on GitHub"
                        : "Click to open the job on GitHub"}
                    </Box>
                  )}
                </>
              )}
            </Paper>
          )}
        </Box>
        {width > 0 && (
          <Box
            onMouseMove={handleFooterMove}
            onMouseLeave={() => setHover(null)}
            sx={{
              position: "sticky",
              bottom: 0,
              zIndex: 1,
              height: footerHeight(pinnedCommit !== null, scrollable),
              backgroundColor: band,
              borderTop: `1px solid ${hairline}`,
              borderBottomLeftRadius: `${radius - TABLE_BORDER}px`,
              borderBottomRightRadius: `${radius - TABLE_BORDER}px`,
              overflow: "hidden",
            }}
          >
            {/* The day labels, each at its day's first column, with a short
              tick where the day changes, so the strip reads against the
              hairlines above it. They scroll with the plot, in a scroller
              of their own under the plot's columns that shows the
              scrollbar for both at the strip's bottom edge, where it is in
              reach however tall the grid. */}
            <Box
              ref={footerScrollerRef}
              onScroll={(event) =>
                syncScroll(event.currentTarget, plotScrollerRef.current)
              }
              sx={{
                position: "absolute",
                left: plotX,
                right: 0,
                top: 0,
                bottom: 0,
                overflowX: "auto",
                overflowY: "hidden",
                scrollbarWidth: "thin",
                scrollbarColor: `${theme.palette.action.disabled} transparent`,
                "&::-webkit-scrollbar": { height: 8 },
                "&::-webkit-scrollbar-thumb": {
                  backgroundColor: theme.palette.action.disabled,
                  borderRadius: 4,
                },
              }}
            >
              {plotWidth > 0 && (
                <svg
                  width={plotWidth}
                  height={GRID_SIZES.axisHeight - 1}
                  viewBox={`0 0 ${plotWidth} ${GRID_SIZES.axisHeight - 1}`}
                  aria-hidden="true"
                  style={{ display: "block", fontFamily }}
                >
                  {marks.map((mark, index) => {
                    const start = x(mark.index) - gap / 2;
                    const next = marks[index + 1];
                    const end =
                      next === undefined ? plotWidth : x(next.index) - gap / 2;
                    return (
                      <g key={mark.index}>
                        {mark.index > 0 && (
                          <line
                            x1={start}
                            x2={start}
                            y1={0}
                            y2={5}
                            stroke={hairline}
                            style={SHAPE_STYLE}
                          />
                        )}
                        {end - start >= DAY_LABEL_MIN_WIDTH && (
                          <text
                            x={start + 5}
                            y={(GRID_SIZES.axisHeight - 1) / 2 + 4}
                            fill={theme.palette.text.secondary}
                            style={{ fontSize: captionSize }}
                          >
                            {dayjs(mark.date).format("ddd, MMM D")}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>
              )}
            </Box>
            {hoveredCommit !== null && (
              <Box
                ref={pillRef}
                sx={{
                  position: "absolute",
                  top: 5,
                  left: clamp(cellCenter, overlay.pill),
                  transform: "translateX(-50%)",
                  pointerEvents: "none",
                  px: 1,
                  borderRadius: "999px",
                  // Blue, as the band over the column is, so the commit under
                  // the pointer is not missed on the footer's grey.
                  backgroundColor: pill.background,
                  color: pill.text,
                  whiteSpace: "nowrap",
                  fontSize: captionSize,
                  lineHeight: 1.5,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <Box
                  component="span"
                  sx={{ fontFamily: MONOSPACE_FONT_FAMILY }}
                >
                  {hoveredCommit.sha.slice(0, 9)}
                </Box>{" "}
                · {formatWhen(hoveredCommit.started_at)}
              </Box>
            )}
            {/* The found commit's pill, pinned under its column on the
            strip's second row, below the day labels and the pointer's pill,
            so neither ever covers the other. */}
            {pinnedCommit !== null && pinnedColumn !== null && (
              <Box
                ref={pinnedPillRef}
                sx={{
                  position: "absolute",
                  top: GRID_SIZES.axisHeight,
                  left: clamp(
                    viewX(x(pinnedColumn) + cellWidth / 2),
                    overlay.pinned
                  ),
                  transform: "translateX(-50%)",
                  pointerEvents: "none",
                  px: 1,
                  borderRadius: "999px",
                  backgroundColor: pinned.background,
                  color: pinned.text,
                  whiteSpace: "nowrap",
                  fontSize: captionSize,
                  lineHeight: 1.5,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <Box
                  component="span"
                  sx={{ fontFamily: MONOSPACE_FONT_FAMILY }}
                >
                  {pinnedCommit.sha.slice(0, 9)}
                </Box>{" "}
                · {formatWhen(pinnedCommit.started_at)}
              </Box>
            )}
          </Box>
        )}
      </>
    );
  }

  // The frame and its caption are one block, so the page's column puts
  // its spacing after the caption and not between the two.
  return (
    <Box>
      <Box
        ref={containerRef}
        sx={{
          border: `${TABLE_BORDER}px solid var(--table-border-color)`,
          borderRadius: `${radius}px`,
          // Nothing here turns selection off: every text in the table, the
          // titles, the workflows' names, the labels, the counts and the day
          // labels, can be dragged over and copied, as in any table.
        }}
      >
        {/* The header band: the column titles, a short rule between the
          columns, and the table's keys at its right end. */}
        <Box
          sx={{
            // Stuck to the viewport's top while the grid runs on below it,
            // so the titles and the keys stay to hand; above the body and the footer strip.
            position: "sticky",
            top: 0,
            zIndex: 3,
            height: GRID_SIZES.headerHeight,
            backgroundColor: band,
            borderBottom: `1px solid ${hairline}`,
            borderTopLeftRadius: `${radius - TABLE_BORDER}px`,
            borderTopRightRadius: `${radius - TABLE_BORDER}px`,
          }}
        >
          <HeaderTitle
            sx={{
              left: GRID_SIZES.sectionIndent,
              transform: "translateY(-50%)",
            }}
            title={descriptions.configuration}
          >
            Configuration
          </HeaderTitle>
          <HeaderTitle
            sx={{ left: outcomes[0].swatchX, transform: "translateY(-50%)" }}
            title={descriptions.outcomes}
          >
            Outcomes
          </HeaderTitle>
          <HeaderTitle
            sx={{ left: plotX, transform: "translateY(-50%)" }}
            title={descriptions.runs}
          >
            Runs
          </HeaderTitle>
          {rules.map((rule) => (
            <Box
              key={rule}
              aria-hidden
              sx={{
                position: "absolute",
                left: rule,
                top: 12,
                bottom: 12,
                borderLeft: `1px solid ${headerRuleColor(theme)}`,
              }}
            />
          ))}
          <Box
            sx={{
              position: "absolute",
              right: HEADER_FILTER_INSET,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              gap: 1,
            }}
          >
            {choices === null ? (
              <>
                <Skeleton
                  variant="rounded"
                  width={150}
                  height={HEADER_FILTER_SIZE}
                />
                <Skeleton
                  variant="rounded"
                  width={72}
                  height={HEADER_FILTER_SIZE}
                />
                <Skeleton
                  variant="rounded"
                  width={108}
                  height={HEADER_FILTER_SIZE}
                />
                <Skeleton
                  variant="rounded"
                  width={118}
                  height={HEADER_FILTER_SIZE}
                />
                <Skeleton
                  variant="rounded"
                  width={96}
                  height={HEADER_FILTER_SIZE}
                />
              </>
            ) : (
              <>
                {/* A commit to find by its hash: its column is banded and
                    its pill pinned in the footer; a hash that names no
                    column says so under the key. */}
                <HeaderSearch
                  label="Find a commit by its hash"
                  placeholder="Commit hash"
                  value={choices.query.commit}
                  onChange={(commit) =>
                    onQueryChange({ ...choices.query, commit })
                  }
                  message={searchMessage}
                />
                <HeaderSelect<RanOn>
                  label="Code source"
                  display={labelOf(
                    choices.query.ranOn,
                    choices.options.ran_on.values
                  )}
                  options={choices.options.ran_on.values}
                  value={choices.query.ranOn}
                  onChange={(ranOn) =>
                    onQueryChange({ ...choices.query, ranOn })
                  }
                />
                <HeaderSelect<HealthWindow>
                  label="Window"
                  display={`Last ${labelOf(
                    choices.query.window,
                    choices.options.window.values
                  )}`}
                  options={choices.options.window.values}
                  value={choices.query.window}
                  onChange={(window) =>
                    onQueryChange({ ...choices.query, window })
                  }
                />
                {/* The outcomes shown: several at once, each item led by
                    the swatch of its cells, the key filled in the accent
                    while the grid is narrowed. */}
                <HeaderSelect<CellStatus>
                  label="Outcomes shown"
                  display={outcomesLabel(choices.query.outcomes)}
                  options={CELL_STATUSES.map((status) => ({
                    value: status,
                    label: OUTCOME_LABELS[status],
                    adornment: <Swatch theme={theme} status={status} />,
                  }))}
                  multiple
                  allLabel="All outcomes"
                  value={choices.query.outcomes}
                  active={narrowed}
                  onChange={(shown) =>
                    onQueryChange({ ...choices.query, outcomes: shown })
                  }
                />
                {/* The time bar, on unless the reader turns it off; off,
                    unticked and disabled, in the pull request view, whose
                    commits are no line for a stretch to run along. The
                    reader's choice stays in the URL for the return to
                    main. */}
                <HeaderCheck
                  label="Time bar"
                  title={
                    timeBarAvailable(choices.query.ranOn)
                      ? "Show the time bar under each configuration's runs"
                      : "No time bar for pull request runs"
                  }
                  checked={timeBar}
                  disabled={!timeBarAvailable(choices.query.ranOn)}
                  onChange={(checked) =>
                    onQueryChange({ ...choices.query, timeBar: checked })
                  }
                />
              </>
            )}
          </Box>
        </Box>
        {/* The body, with the progress bar of a grid on its way running under
          the header band, as the list's grid shows one over its rows. */}
        <Box sx={{ position: "relative" }}>
          {loading && error === undefined && (
            <LinearProgress
              aria-label="Loading the runs"
              sx={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                zIndex: 2,
              }}
            />
          )}
          {body}
        </Box>
      </Box>
      <LoadTime timing={timing} loading={loading && error === undefined} />
    </Box>
  );
}
