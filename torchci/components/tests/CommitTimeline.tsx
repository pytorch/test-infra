import { Box, Skeleton, useTheme } from "@mui/material";
import { alpha, keyframes, type Theme } from "@mui/material/styles";
import LoadError from "components/tests/LoadError";
import {
  ClockContext,
  filesRowId,
  NodeRows,
  RowsContext,
  RowTarget,
  TimelineRowsContext,
  TipDescriber,
} from "components/tests/TimelineRows";
import {
  clock,
  clockSeconds,
  hatchFill,
  MarkKind,
  plainTip,
  PointerTip,
  queueDots,
  Swatch,
} from "components/tests/TimelineTips";
import dayjs from "dayjs";
import { timeRangeLabel } from "lib/tests/commit";
import { headerBandColor } from "lib/tests/headerColors";
import {
  firstRoundTime,
  hoursLabel,
  nodeOfPick,
  pathTo,
  percentLabel,
  pickAbove,
  pickKey,
  pickOfNode,
  spanLabel,
  Stretch,
  tickStep,
  Timeline,
  timelineFiles,
  TimelinePick,
  timelineSteps,
  Totals,
  viewOf,
} from "lib/tests/timeline";
import { timelineColors } from "lib/tests/timelineColors";
import { useJobDetail } from "lib/tests/useCommitJobs";
import { useHeldPlace } from "lib/tests/useHeldPlace";
import { useIsomorphicLayoutEffect } from "lib/tests/useIsomorphicLayoutEffect";
import {
  CSSProperties,
  forwardRef,
  MouseEvent,
  MutableRefObject,
  ReactNode,
  RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// The commit page's timeline: every job of the commit on the clock, from
// GET /api/tests/commit/{sha}/jobs. A row is a name and a track: folded, a
// workflow's or a build's jobs are a ribbon as tall at each minute as the
// jobs then running; a job is a bar, dots while it was queued, and while it
// is open its bar is cut into its steps; inside a job its test files and
// their tests are bars on the same clock, which closes in on what is open.
// While a job is open only the way down to
// the pick is listed, the other rows of each level folded into a line, and
// the rows outside the pick are grey. A click picks a row, and the table
// under the timeline lists the pick's tests. The jobs arrive before what
// their tests did: until that is in, the rows are drawn in the grey of the
// hub's placeholders, a ribbon as its outline and a bar as its length, and
// every color arrives together. The rows are in TimelineRows, what they
// are drawn from in lib/tests/timeline.ts.

export interface CommitTimelineProps {
  repo: string;
  sha: string;
  // The commit's jobs; undefined until they arrive.
  timeline: Timeline | undefined;
  // The jobs' failure, or with a timeline their tests'.
  error: unknown;
  onRetry: () => void;
  pick: TimelinePick | null;
  // A row clicked: what is picked from now on, null for the whole commit,
  // and where the row's name stood when a row was picked.
  onPick: (_pick: TimelinePick | null, _from?: DOMRect) => void;
  // The pick (pickKey) made in the table's Job header, taken when it lands:
  // the timeline does not scroll to it.
  pickedInTable: MutableRefObject<string | null>;
}

// The key to the picture, and what each word's tooltip says of it.
const KEY: {
  kind: MarkKind;
  name: string;
  says: string;
  time: (_totals: Totals) => number;
}[] = [
  {
    kind: "tests",
    name: "Tests",
    says: "Time when at least one recorded test was running.",
    time: (totals) => totals.covered,
  },
  {
    kind: "unaccounted",
    name: "Unaccounted",
    says: "Time inside a Test step when no recorded test was running.",
    time: (totals) => totals.unaccounted,
  },
  {
    kind: "other",
    name: "Other steps",
    says: "Setup, build, upload and every step other than Test.",
    time: (totals) => totals.other,
  },
  {
    kind: "queue",
    name: "Queued",
    says: "Waiting for a runner, then for the job's container to start.",
    time: (totals) => totals.queue,
  },
];

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
// The pulse of the hub's placeholders (MUI's Skeleton).
const wait = keyframes`
  0% { opacity: 1; }
  50% { opacity: 0.4; }
  100% { opacity: 1; }
`;
// How long the rows take to settle after a pick: they open and fold away
// in 280ms and the clock closes in in 420ms.
const SETTLED = 600;

// Every rule of the box in one place, by class: a commit has hundreds of
// rows, and a style of its own on each would cost more than it gives.
function timelineSx(theme: Theme) {
  const colors = timelineColors(theme);
  const { text, background, primary } = theme.palette;
  const dark = theme.palette.mode === "dark";
  const band = headerBandColor(theme);
  const hatch = hatchFill(colors);
  const dots = queueDots(colors.queue);
  return {
    position: "relative",
    border: "1px solid var(--table-border-color)",
    borderRadius: "4px",
    "& i": { fontStyle: "normal" },

    // The line over the timeline: how long the jobs ran, and the key.
    "& .tl-head": {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: "4px 28px",
      padding: "11px 16px 10px",
      fontSize: 15,
      lineHeight: "22px",
      color: text.secondary,
      borderBottom: `1px solid ${theme.palette.divider}`,
    },
    "& .tl-head .ran": { whiteSpace: "nowrap", cursor: "default" },
    "& .tl-head .ran b": {
      fontWeight: 600,
      color: text.primary,
      fontVariantNumeric: "tabular-nums",
    },
    "& .tl-head .range": { marginLeft: "4px" },
    "& .tl-key": {
      display: "flex",
      flexWrap: "wrap",
      gap: "2px 18px",
      fontSize: 13,
    },
    "& .tl-key .item": {
      display: "inline-flex",
      alignItems: "center",
      gap: "7px",
      whiteSpace: "nowrap",
      cursor: "default",
    },
    "& .tl-sw": {
      display: "inline-block",
      flex: "none",
      width: 14,
      height: 10,
      borderRadius: "2px",
    },
    "& .tl-sw.tests": { background: colors.tests },
    "& .tl-sw.other": { background: colors.other },
    "& .tl-sw.unaccounted": {
      boxShadow: `inset 0 0 0 1px ${colors.hatch}`,
      backgroundImage: hatch,
    },
    "& .tl-sw.queue": {
      width: 15,
      height: 3,
      marginRight: "-1px",
      borderRadius: 0,
      background: dots,
    },
    "& .tl-pad": { position: "relative", padding: "14px 16px 16px" },
    "& .tl-none": { fontSize: 14, color: text.secondary },

    // The clock.
    "& .tl": {
      position: "relative",
      "--labelw": "330px",
      "--zl": 0,
      "--zw": 100,
    },
    // The names inside a job are longer.
    "& .tl.deep": { "--labelw": "420px" },
    "@media (max-width: 1180px)": {
      "& .tl": { "--labelw": "250px" },
      "& .tl.deep": { "--labelw": "320px" },
    },
    "& .tl-axis": {
      position: "relative",
      height: 22,
      marginLeft: "var(--labelw)",
      fontSize: 12,
      lineHeight: "16px",
      color: text.secondary,
      fontVariantNumeric: "tabular-nums",
    },
    "& .tl-axis span": {
      position: "absolute",
      top: 0,
      transform: "translateX(-50%)",
      whiteSpace: "nowrap",
      transition: "color 160ms",
    },
    "& .tl-axis span.first": { transform: "none" },
    "& .tl-axis span.last": { transform: "translateX(-100%)" },
    // The pointer on the duration lights the two ends it measures.
    "&:has(.tl-head .ran:hover) .tl-axis span.first, &:has(.tl-head .ran:hover) .tl-axis span.last":
      { color: text.primary },
    "& .tl-when": {
      position: "absolute",
      top: 1,
      zIndex: 4,
      transform: "translateX(-50%)",
      padding: "1px 7px",
      borderRadius: "6px",
      background: text.primary,
      color: background.default,
      fontSize: 11.5,
      lineHeight: "16px",
      whiteSpace: "nowrap",
      pointerEvents: "none",
      opacity: 0,
      transition: "opacity 120ms",
    },
    "& .tl-when.on": { opacity: 1 },
    "& .tl-body": { position: "relative" },
    "& .tl-grid": {
      position: "absolute",
      left: "var(--labelw)",
      right: 0,
      top: 0,
      bottom: 0,
      pointerEvents: "none",
    },
    "& .tl-grid i": {
      position: "absolute",
      top: 0,
      bottom: 0,
      width: "1px",
      background: colors.gridLine,
    },
    "& .tl-grid i.half": { opacity: 0.5 },
    "& .tl-cursor": {
      position: "absolute",
      top: 0,
      bottom: 0,
      width: "1px",
      background: text.secondary,
      pointerEvents: "none",
      opacity: 0,
      transition: "opacity 120ms",
      zIndex: 3,
    },
    "& .tl-cursor.on": { opacity: 0.55 },

    // A row: its name and its track.
    "& .tl-row": {
      display: "grid",
      gridTemplateColumns: "var(--labelw) minmax(0, 1fr)",
      alignItems: "center",
      width: "100%",
      minHeight: 26,
      borderRadius: "6px",
      position: "relative",
      transition: "background-color 120ms",
      // A row brought into view clears the table's title docked under it.
      scrollMargin: "12px 0 170px",
    },
    // A row that a click acts on.
    "& .tl-row[role=button]": { cursor: "pointer" },
    "& .tl-row[role=button]:hover": {
      background: theme.palette.action.hover,
    },
    "& .tl-row.sel": { background: colors.selected },
    "& .tl-row:focus-visible": {
      outline: `2px solid ${primary.main}`,
      outlineOffset: -2,
    },
    // While a job is open, a row outside the pick is grey until the pointer
    // or the keyboard is on it; the names on the way down stay dark.
    "& .tl-row.rest .tl-trk": {
      filter: "grayscale(1)",
      opacity: 0.3,
      transition: "opacity 120ms, filter 120ms",
    },
    "& .tl-row.rest:hover .tl-trk, & .tl-row.rest:focus-visible .tl-trk": {
      filter: "none",
      opacity: 1,
    },
    "& .tl-row.rest:not(.way) .nm": { color: text.secondary },
    "& .tl-row.rest[role=button]:hover .nm, & .tl-row.rest:focus-visible .nm": {
      color: text.primary,
    },
    "& .tl-row.d0": { minHeight: 50 },
    "& .tl-row.job, & .tl-row.file, & .tl-row.test, & .tl-row.note": {
      minHeight: 22,
    },
    "& .tl-lbl": {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      minWidth: 0,
      padding: "3px 12px 3px calc(4px + var(--depth, 0) * 18px)",
      fontSize: 13.5,
      lineHeight: "17px",
    },
    "& .tl-lbl .cv": {
      flex: "none",
      width: 16,
      height: 16,
      color: text.secondary,
      transition: `transform 200ms ${EASE}`,
    },
    "& .tl-row.open > .tl-lbl .cv": { transform: "rotate(90deg)" },
    "& .tl-lbl .cv.none": { visibility: "hidden" },
    "& .tl-lbl .nm": { minWidth: 0, overflowWrap: "anywhere" },
    "& .tl-row.d0 .nm": { fontSize: 15, fontWeight: 600 },
    "& .tl-row.d1 .nm": { fontWeight: 500 },
    "& .tl-row.file .nm, & .tl-row.test .nm": { fontSize: 13 },
    "& .tl-row.quiet .nm, & .tl-row.quiet .ct, & .tl-row.note .nm": {
      color: text.secondary,
    },
    "& .tl-lbl .ct": {
      flex: "none",
      fontSize: 12,
      color: text.secondary,
      fontVariantNumeric: "tabular-nums",
    },
    "& .tl-lbl .marks": {
      display: "inline-flex",
      flex: "none",
      gap: "4px",
      marginLeft: "auto",
    },
    "& .tl-mk": {
      padding: "0 6px",
      borderRadius: "999px",
      fontSize: 11.5,
      lineHeight: "16px",
      fontWeight: 600,
      fontVariantNumeric: "tabular-nums",
      whiteSpace: "nowrap",
    },
    "& .tl-mk.failed": {
      background: colors.failedWash,
      color: colors.failedInk,
    },
    "& .tl-mk.flaky": { background: colors.flakyWash, color: colors.flakyInk },
    "& .tl-mk.plain": { background: band, color: text.secondary },
    // A row's badge, in its name's line.
    "& .nm .tl-mk": { display: "inline-block", verticalAlign: "1px" },

    // A track holds its marks in one block that the clock scales: the whole
    // commit at rest, the open job or file from there down.
    "& .tl-trk": {
      position: "relative",
      height: 16,
      margin: "3px 0",
      overflowX: "clip",
    },
    "& .tl-row.d0 .tl-trk": { height: 38 },
    "& .tl-row.d2 .tl-trk": { height: 12 },
    "& .tl-row.job .tl-trk, & .tl-row.file .tl-trk": { height: 10 },
    "& .tl-row.test .tl-trk": { height: 8 },
    "& .tl-in": {
      position: "absolute",
      top: 0,
      bottom: 0,
      left: "calc(var(--zl) * 1%)",
      width: "calc(var(--zw) * 1%)",
      transition: `left 420ms ${EASE}, width 420ms ${EASE}`,
    },
    "@media (prefers-reduced-motion: reduce)": {
      "& .tl-in": { transition: "none" },
    },

    // A folded row's ribbon.
    "& .tl-lay": { position: "absolute", inset: 0 },
    "& .tl-lay.tests": { background: colors.tests },
    // The hatch is drawn once. A box that does not sit on whole pixels has
    // its background tiled, and a tile as wide as a row of a closed-in clock
    // is drawn small and stretched: a smear.
    "& .tl-lay.unaccounted": {
      backgroundImage: hatch,
      backgroundRepeat: "no-repeat",
    },
    "& .tl-lay.other": { background: colors.other },

    // While the jobs' tests are on their way: a ribbon and a bar in the grey
    // of the hub's placeholders, moving as they do, and the queue's dots
    // faint. Still once the tests have failed to arrive.
    "& .tl.wait .tl-lay, & .tl.wait .tl-b": {
      background: alpha(text.primary, dark ? 0.13 : 0.11),
      animation: `${wait} 2s ease-in-out 0.5s infinite`,
      "@media (prefers-reduced-motion: reduce)": { animation: "none" },
    },
    "& .tl.wait.still .tl-lay, & .tl.wait.still .tl-b": { animation: "none" },
    "& .tl.wait .tl-q": { opacity: 0.35 },

    // A job: a line of dots while it waits, a bar for its own work, hatched
    // over its Test step until a recorded test covers it. An open job's bar
    // is cut where a step ends, in the colour of what the bar lies on.
    "& .tl-q": {
      position: "absolute",
      top: "50%",
      height: 3,
      marginTop: "-1.5px",
      minWidth: 3,
      background: dots,
    },
    "& .tl-b": {
      position: "absolute",
      top: 0,
      bottom: 0,
      minWidth: 2,
      borderRadius: "2px",
      background: colors.other,
      overflow: "hidden",
    },
    "& .tl-b i": { position: "absolute", top: 0, bottom: 0 },
    "& .tl-b i.t": {
      backgroundColor: background.default,
      backgroundImage: hatch,
      backgroundRepeat: "no-repeat",
    },
    "& .tl-b i.c": { background: colors.tests },
    // In px: the theme reads a size of 1 as the whole width.
    "& .tl-b i.s": { width: "1px", background: background.default },
    "& .tl-row.sel .tl-b i.s": {
      background: `linear-gradient(${colors.selected}, ${colors.selected}), ${background.default}`,
    },
    "& .tl-cap": {
      position: "absolute",
      top: -2,
      bottom: -2,
      width: 3,
      borderRadius: "1.5px",
      background: colors.failed,
    },
    "& .tl-cap.cancelled": { background: text.secondary },
    "& .tl-skip": {
      position: "absolute",
      top: 1,
      bottom: 1,
      width: 8,
      marginLeft: "-4px",
      border: `1px dashed ${text.disabled}`,
      borderRadius: "2px",
    },

    // Inside a job: what happened to it, its files, their tests.
    "& .tl-facts": {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: "2px 7px",
      padding: "1px 12px 5px calc(26px + var(--depth, 0) * 18px)",
      fontSize: 12.5,
      lineHeight: "18px",
      color: text.secondary,
    },
    "& .verdict": { fontWeight: 500, color: text.primary },
    "& .verdict.failed": { color: colors.failedInk },
    "& .verdict.flaky": { color: colors.flakyInk },
    "& .tl-run, & .tl-at": {
      position: "absolute",
      top: 0,
      bottom: 0,
      minWidth: 2,
      borderRadius: "2px",
      background: colors.tests,
    },
    "& .tl-run.failed, & .tl-at.failing": { background: colors.failed },
    "& .tl-run.flaky": { background: colors.flaky },
    "& .tl-run.skipped": { background: colors.skipped },
    "& .tl-run.quiet": { opacity: 0.55 },
    "& .tl-at.skipped": {
      background: "none",
      boxShadow: `inset 0 0 0 1px ${text.disabled}`,
    },
    "& .tl-at.other": { background: text.disabled },
  };
}

const hourLabel = (seconds: number) => dayjs.unix(seconds).format("h a");
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

// The clock's labels and lines for the part of it in view: round times, at
// most nine of them, and a fainter line halfway between; the whole clock
// says its two ends as well.
function ticksOf(view: Stretch, whole: boolean) {
  const length = view.end - view.start;
  const position = (time: number) => (100 * (time - view.start)) / length;
  const step = tickStep(length);
  const say = step >= 3600 ? hourLabel : step >= 60 ? clock : clockSeconds;
  // From the start's next whole second: a round time is one, and none lies
  // before the start.
  const first = firstRoundTime(step, Math.ceil(view.start));
  const labels: { at: number; text: string; end?: "first" | "last" }[] = [];
  const lines: { at: number; half: boolean }[] = [];
  for (let tick = first; tick < view.end; tick += step) {
    lines.push({ at: position(tick), half: false });
    if (position(tick) < 97) {
      labels.push({ at: position(tick), text: say(tick) });
    }
  }
  for (let tick = first - step / 2; tick < view.end; tick += step) {
    if (tick > view.start) lines.push({ at: position(tick), half: true });
  }
  if (whole) {
    labels.unshift({ at: 0, text: clock(view.start), end: "first" });
    labels.push({ at: 100, text: clock(view.end), end: "last" });
  }
  return { labels, lines };
}

// The rows under the pointer: a line across them at the pointer's time, the
// time over the clock, and what the row under the pointer says of it, in a
// tooltip. The pointer's moves are kept out of the rows, which do not draw
// again for them.
function Hover({
  timeline,
  view,
  tips,
  whenRef,
  children,
}: {
  timeline: Timeline;
  view: Stretch;
  tips: Map<string, TipDescriber>;
  whenRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const [tip, setTip] = useState<ReactNode>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ target: Element; x: number } | null>(null);
  const frame = useRef<number | null>(null);
  const clear = () => {
    cursorRef.current?.classList.remove("on");
    whenRef.current?.classList.remove("on");
    setTip(null);
  };
  const show = () => {
    frame.current = null;
    const body = bodyRef.current;
    const cursor = cursorRef.current;
    const when = whenRef.current;
    const row =
      pointer.current?.target.closest<HTMLElement>(".tl-row[data-row]") ?? null;
    const describe = tips.get(row?.dataset.row ?? "");
    if (
      body === null ||
      cursor === null ||
      when === null ||
      row === null ||
      pointer.current === null ||
      describe === undefined
    ) {
      clear();
      return;
    }
    const box = body.getBoundingClientRect();
    const labelWidth =
      row.firstElementChild?.getBoundingClientRect().width ?? 0;
    const trackWidth = Math.max(1, box.width - labelWidth);
    const offset = pointer.current.x - box.left - labelWidth;
    const overName = offset < 0;
    const length = view.end - view.start;
    const time = Math.max(
      timeline.start,
      Math.min(
        timeline.end,
        view.start + (Math.max(0, offset) / trackWidth) * length
      )
    );
    cursor.classList.toggle("on", !overName);
    when.classList.toggle("on", !overName);
    if (!overName) {
      cursor.style.left = `${labelWidth + offset}px`;
      when.textContent = (length < 900 ? clockSeconds : clock)(time);
      when.style.left = `${(100 * offset) / trackWidth}%`;
    }
    setTip(describe(overName ? null : time));
  };
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    []
  );
  return (
    <PointerTip title={tip}>
      <div
        className="tl-body"
        ref={bodyRef}
        onMouseMove={(event: MouseEvent<HTMLDivElement>) => {
          pointer.current = {
            target: event.target as Element,
            x: event.clientX,
          };
          if (frame.current === null) {
            frame.current = requestAnimationFrame(show);
          }
        }}
        onMouseLeave={() => {
          pointer.current = null;
          clear();
        }}
      >
        {children}
        <div className="tl-cursor" ref={cursorRef} />
      </div>
    </PointerTip>
  );
}

function Chart({
  repo,
  sha,
  timeline,
  testsFailed,
  pick,
  onPick,
  pickedInTable,
}: Omit<CommitTimelineProps, "timeline" | "error" | "onRetry"> & {
  timeline: Timeline;
  // The jobs' tests did not arrive: nothing is on its way.
  testsFailed: boolean;
}) {
  // The first row is open on arrival when a job failed, until it is clicked.
  const [rootChoice, setRootChoice] = useState<boolean | null>(null);
  const rootOpen = rootChoice ?? timeline.root.totals.failed > 0;
  // The rows that fold others away and are open: the smaller workflows, the
  // bots, and a job's shorter files.
  const [folds, setFolds] = useState<ReadonlySet<string>>(() => new Set());
  // The lines of rows folded away while a job is open that are open: for
  // the pick they were opened under, and closed again by the next.
  const key = pickKey(pick);
  const [others, setOthers] = useState<{
    pick: string;
    open: ReadonlySet<string>;
  }>({ pick: key, open: new Set() });
  if (others.pick !== key) setOthers({ pick: key, open: new Set() });
  const open = useMemo(
    () =>
      new Set([
        ...folds,
        ...others.open,
        ...(rootOpen ? [timeline.root.id] : []),
      ]),
    [folds, others, rootOpen, timeline]
  );
  const pickNode = useMemo(() => nodeOfPick(timeline, pick), [timeline, pick]);
  const onPath = useMemo(
    () =>
      new Set(pickNode === null ? [] : pathTo(pickNode).map((row) => row.id)),
    [pickNode]
  );
  const inJob =
    pick !== null &&
    (pick.kind === "job" || pick.kind === "file" || pick.kind === "test");
  const pickedId =
    pickNode !== null && pick?.kind !== "file" && pick?.kind !== "test"
      ? pickNode.id
      : null;
  const pickedJob = inJob ? pickNode?.job ?? null : null;
  // An open job has the clock, and the rows, to itself.
  const focused = pickedJob !== null && pickedJob.kind !== "skipped";
  const pickedPath =
    pick?.kind === "file" || pick?.kind === "test" ? pick.file : null;

  // The clock closes in on the open job, and inside it on the open file,
  // whose times are the job's own to give: asked for with the job's rows,
  // which read the same answer. It gives the job's steps too, for its bar.
  const { data: detail } = useJobDetail(pickedJob?.job.id ?? null);
  const steps = useMemo(
    () =>
      detail === undefined || pickedJob === null
        ? null
        : timelineSteps(detail.steps, pickedJob),
    [detail, pickedJob]
  );
  const pickedFile = useMemo(() => {
    const file =
      detail === undefined
        ? undefined
        : timelineFiles(detail).find(({ path }) => path === pickedPath);
    return file === undefined ? null : { start: file.start, end: file.end };
  }, [detail, pickedPath]);
  const view = useMemo(
    () => viewOf(timeline, pickedJob, pickedFile),
    [timeline, pickedJob, pickedFile]
  );
  const whole = view.start === timeline.start && view.end === timeline.end;
  const span = Math.max(1, timeline.end - timeline.start);
  const length = Math.max(1, view.end - view.start);
  const ticks = useMemo(() => ticksOf(view, whole), [view, whole]);

  // The whole clock's two ends win where a round time would touch them.
  const axisRef = useRef<HTMLDivElement>(null);
  useIsomorphicLayoutEffect(() => {
    const axis = axisRef.current;
    if (axis === null) return;
    const tidy = () => {
      const labels = Array.from(axis.querySelectorAll<HTMLElement>(".round"));
      for (const label of labels) label.style.visibility = "";
      const first = axis.querySelector(".first");
      const last = axis.querySelector(".last");
      if (first === null || last === null) return;
      const edge = first.getBoundingClientRect().right + 12;
      const limit = last.getBoundingClientRect().left - 12;
      for (const label of labels) {
        const box = label.getBoundingClientRect();
        if (box.left < edge || box.right > limit) {
          label.style.visibility = "hidden";
        }
      }
    };
    tidy();
    window.addEventListener("resize", tidy);
    return () => window.removeEventListener("resize", tidy);
  }, [ticks]);

  // A pick made elsewhere, a step back or the table's title, is brought
  // into view once its rows have opened; one made in the table's Job header
  // is not, the reader being in the table.
  const rootRef = useRef<HTMLDivElement>(null);
  const arrived = useRef(false);
  useEffect(() => {
    if (!arrived.current) {
      arrived.current = true;
      return;
    }
    const inTable = pickedInTable.current === pickKey(pick);
    pickedInTable.current = null;
    if (inTable) {
      return;
    }
    const timer = setTimeout(
      () =>
        rootRef.current
          ?.querySelector(".tl-row.sel")
          ?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
      300
    );
    return () => clearTimeout(timer);
  }, [pick, pickedInTable]);

  // A row that was clicked stays where it is in the window while the rows
  // above it fold away or come back: the window scrolls by as much as the
  // row moved, as far as it can, until the rows have settled. The row is
  // found again by its ID, and given the focus it had: one picked from a
  // line of folded rows is drawn anew in its place on the way.
  const holdPlace = useHeldPlace();
  const clicked = useRef<{ id: string; top: number; focus: boolean } | null>(
    null
  );
  const release = useRef<ReturnType<typeof setTimeout>>();
  useIsomorphicLayoutEffect(() => {
    const was = clicked.current;
    clicked.current = null;
    if (was === null) return;
    const row = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>(".tl-row[data-row]") ?? []
    ).find((candidate) => candidate.dataset.row === was.id);
    if (row === undefined) return;
    window.scrollBy(0, row.getBoundingClientRect().top - was.top);
    if (was.focus && document.activeElement !== row) {
      row.focus({ preventScroll: true });
    }
    holdPlace(row);
    clearTimeout(release.current);
    release.current = setTimeout(() => holdPlace(null), SETTLED);
  });
  useEffect(() => () => clearTimeout(release.current), []);

  const latest = useRef({ timeline, pick, onPick, folds, onPath, rootOpen });
  latest.current = { timeline, pick, onPick, folds, onPath, rootOpen };
  const handleActivate = useCallback((target: RowTarget, row: HTMLElement) => {
    const current = latest.current;
    const from = row.querySelector(".nm")?.getBoundingClientRect();
    // For the draw this click brings, and no later one.
    clicked.current = {
      id: row.dataset.row ?? "",
      top: row.getBoundingClientRect().top,
      focus: document.activeElement === row,
    };
    setTimeout(() => {
      clicked.current = null;
    }, 0);
    const toggleFold = (id: string, isOpen: boolean) =>
      setFolds((previous) => {
        const next = new Set(previous);
        if (isOpen) next.delete(id);
        else next.add(id);
        return next;
      });
    if (target.kind === "others") {
      setOthers((previous) => {
        const next = new Set(previous.open);
        if (next.has(target.id)) next.delete(target.id);
        else next.add(target.id);
        return { pick: previous.pick, open: next };
      });
      return;
    }
    if (target.kind === "test") {
      const { job, file, test } = target;
      const picked =
        current.pick?.kind === "test" &&
        current.pick.jobId === job.job.id &&
        current.pick.file === file.path &&
        current.pick.suite === test.suite &&
        current.pick.caseName === test.name;
      const next: TimelinePick = {
        kind: "test",
        jobId: job.job.id,
        file: file.path,
        suite: test.suite,
        caseName: test.name,
      };
      if (picked) current.onPick(pickAbove(current.timeline, next));
      else current.onPick(next, from);
      return;
    }
    if (target.kind === "file") {
      const { job, file } = target;
      const picked =
        current.pick?.kind === "file" &&
        current.pick.jobId === job.job.id &&
        current.pick.file === file.path;
      const next: TimelinePick = {
        kind: "file",
        jobId: job.job.id,
        file: file.path,
      };
      if (picked) current.onPick(pickAbove(current.timeline, next));
      else current.onPick(next, from);
      return;
    }
    if (target.kind === "files") {
      // The shorter files fold away; a pick among them goes back to the job.
      const { job, files } = target;
      const id = filesRowId(job.job.id);
      const inFile =
        current.pick?.kind === "file" || current.pick?.kind === "test"
          ? current.pick
          : null;
      const pickInside =
        inFile !== null &&
        inFile.jobId === job.job.id &&
        files.some((file) => file.path === inFile.file);
      const isOpen = current.folds.has(id) || pickInside;
      toggleFold(id, isOpen);
      if (isOpen && pickInside) {
        current.onPick({ kind: "job", jobId: job.job.id });
      }
      return;
    }
    const { node } = target;
    if (node.type === "root") {
      // The first row clears the pick; with nothing picked it folds the
      // rest away.
      if (current.pick !== null) current.onPick(null);
      else setRootChoice(!current.rootOpen);
      return;
    }
    const next = pickOfNode(node);
    if (next === null) {
      const isOpen = current.folds.has(node.id) || current.onPath.has(node.id);
      toggleFold(node.id, isOpen);
      if (isOpen && current.onPath.has(node.id)) current.onPick(null);
      return;
    }
    const pickedRow = nodeOfPick(current.timeline, current.pick);
    const picked =
      pickedRow === node &&
      current.pick?.kind !== "file" &&
      current.pick?.kind !== "test";
    if (picked) current.onPick(pickAbove(current.timeline, next));
    else current.onPick(next, from);
  }, []);

  const tips = useMemo(() => new Map<string, TipDescriber>(), []);
  const whenRef = useRef<HTMLDivElement>(null);
  const context = useMemo<TimelineRowsContext>(
    () => ({
      repo,
      sha,
      timeline,
      pick,
      open,
      onPath,
      pickedId,
      focused,
      onActivate: handleActivate,
      tips,
      steps,
    }),
    [
      repo,
      sha,
      timeline,
      pick,
      open,
      onPath,
      pickedId,
      focused,
      handleActivate,
      tips,
      steps,
    ]
  );
  // The rows are made here and handed to the pointer's wrapper whole, so
  // its tooltip can change without them.
  const rows = useMemo(
    () => (
      <ClockContext.Provider value={timeline}>
        <RowsContext.Provider value={context}>
          <NodeRows
            node={timeline.root}
            depth={0}
            first
            rootHint={
              pick !== null
                ? "Click to clear the pick."
                : rootOpen
                ? "Click to fold the workflows away."
                : "Click to unfold by workflow."
            }
          />
        </RowsContext.Provider>
      </ClockContext.Provider>
    ),
    [context, timeline, pick, rootOpen]
  );

  const { totals } = timeline.root;
  const running = timeline.root.jobs.some(
    ({ job, kind }) => kind !== "skipped" && job.completed_at === null
  );
  return (
    <>
      <div className="tl-head">
        <PointerTip
          title={plainTip(
            spanLabel(span),
            running
              ? `From the first job queued, ${clock(
                  timeline.start
                )}, to now: jobs are still running.`
              : `From the first job queued, ${clock(
                  timeline.start
                )}, to the last one done, ${clock(timeline.end)}.`
          )}
        >
          <span className="ran">
            <b>{spanLabel(span)}</b>{" "}
            <span className="range">
              {timeRangeLabel(iso(timeline.start), iso(timeline.end))}
            </span>
          </span>
        </PointerTip>
        <div className="tl-key">
          {KEY.map(({ kind, name, says, time }) => (
            <PointerTip
              key={kind}
              title={plainTip(
                name,
                says,
                // How the running time splits waits for the jobs' tests.
                timeline.testsPending && kind !== "queue"
                  ? undefined
                  : `${hoursLabel(time(totals))} in this commit${
                      kind === "queue"
                        ? ""
                        : `, ${percentLabel(
                            time(totals),
                            totals.run
                          )} of its running time`
                    }`
              )}
            >
              <span className="item">
                <Swatch kind={kind} />
                {name}
              </span>
            </PointerTip>
          ))}
        </div>
      </div>
      <div className="tl-pad">
        <div
          ref={rootRef}
          className={[
            "tl",
            whole ? "" : "deep",
            timeline.testsPending ? "wait" : "",
            timeline.testsPending && testsFailed ? "still" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={
            {
              "--zw": (100 * span) / length,
              "--zl": (-100 * (view.start - timeline.start)) / length,
            } as CSSProperties
          }
        >
          <div className="tl-axis" ref={axisRef}>
            {ticks.labels.map(({ at, text, end }) => (
              <span
                key={`${end ?? "round"}:${at}`}
                className={end ?? "round"}
                style={{ left: `${at}%` }}
              >
                {text}
              </span>
            ))}
            <div className="tl-when" ref={whenRef} />
          </div>
          <Hover timeline={timeline} view={view} tips={tips} whenRef={whenRef}>
            <div className="tl-grid">
              {ticks.lines.map(({ at, half }) => (
                <i
                  key={`${half}:${at}`}
                  className={half ? "half" : undefined}
                  style={{ left: `${at}%` }}
                />
              ))}
            </div>
            {rows}
          </Hover>
        </div>
      </div>
    </>
  );
}

// Holds the box while the jobs are on their way: the line over the
// timeline, and a few rows.
function Placeholder() {
  return (
    <Box aria-hidden>
      <div className="tl-head">
        <Skeleton variant="text" sx={{ width: "22ch" }} />
        <Skeleton variant="text" sx={{ width: "38ch" }} />
      </div>
      <div className="tl-pad">
        {[38, 16, 16, 16, 16].map((height, index) => (
          <Box
            key={index}
            sx={{ display: "flex", alignItems: "center", gap: 2, mt: 1 }}
          >
            <Skeleton variant="text" sx={{ width: `${26 - index * 2}ch` }} />
            <Skeleton variant="rounded" height={height} sx={{ flex: 1 }} />
          </Box>
        ))}
      </div>
    </Box>
  );
}

const CommitTimeline = forwardRef<HTMLDivElement, CommitTimelineProps>(
  function CommitTimeline({ timeline, error, onRetry, ...chart }, ref) {
    const theme = useTheme();
    const sx = useMemo(() => timelineSx(theme), [theme]);
    return (
      <Box
        ref={ref}
        component="section"
        aria-label="The commit's jobs on the clock"
        sx={sx}
      >
        {timeline !== undefined ? (
          timeline.root.jobs.length === 0 &&
          timeline.root.children.length === 0 ? (
            <div className="tl-pad tl-none">
              No jobs are recorded for this commit yet.
            </div>
          ) : (
            <>
              {timeline.testsPending && error !== undefined && (
                <Box sx={{ p: 2, pb: 0 }}>
                  <LoadError
                    what="the jobs' tests"
                    error={error}
                    onRetry={onRetry}
                  />
                </Box>
              )}
              <Chart
                timeline={timeline}
                testsFailed={error !== undefined}
                {...chart}
              />
            </>
          )
        ) : error !== undefined ? (
          <Box sx={{ p: 2 }}>
            <LoadError what="the jobs" error={error} onRetry={onRetry} />
          </Box>
        ) : (
          <Placeholder />
        )}
      </Box>
    );
  }
);

export default CommitTimeline;
