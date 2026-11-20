import CheckIcon from "@mui/icons-material/Check";
import CloseIcon from "@mui/icons-material/Close";
import KeyboardArrowDownRoundedIcon from "@mui/icons-material/KeyboardArrowDownRounded";
import { Box, ButtonBase, Skeleton, useTheme } from "@mui/material";
import type { Theme } from "@mui/material/styles";
import { Breakable } from "components/tests/TestName";
import { plainTip, PointerTip } from "components/tests/TimelineTips";
import { hueColors, solidHueColor } from "lib/tests/blockColors";
import { BUNDLE_STATUSES, BundleStatus } from "lib/tests/bundle";
import {
  allPassed,
  barWeight,
  problemHue,
  shareLabel,
  STATUS_TITLES,
  statusWord,
  SUMMARY_STATUS_HUES,
} from "lib/tests/commit";
import { cellStroke } from "lib/tests/gridColors";
import { headerBandColor, headerBandHoverColor } from "lib/tests/headerColors";
import { integerLabel } from "lib/tests/table";
import {
  countLabel,
  countsTotal,
  pickKey,
  ROOT_NAME,
  StatusCounts,
  Timeline,
  TimelinePick,
  trailOf,
} from "lib/tests/timeline";
import { timelineColors } from "lib/tests/timelineColors";
import { useIsomorphicLayoutEffect } from "lib/tests/useIsomorphicLayoutEffect";
import {
  CSSProperties,
  MutableRefObject,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// The title of the commit page's table: what the table lists and the
// summary of those tests. A line over the table says what is listed, "Tests
// in" and the timeline's pick by the timeline's own names; the table's top
// edge is a bar of the tests by status, and its first row their counts,
// with their total at its right. It follows the pick: the whole commit, a
// workflow, a build, a job, a test file or one test. A click on a status
// lists that outcome alone. While the table is under the window's bottom
// edge and the timeline is in the window, the title docks at that edge.
//
// Nothing in it is cut off. The line folds the pick's earlier levels into a
// count; the counts take their gaps in and step their figures down, and only
// then wrap; and a figure on its way to a new value is never wider than it.

// Where a picked row's name stood in the timeline, and the pick it names
// (pickKey): the name travels from there to the title.
export interface Glide {
  from: DOMRect;
  pick: string;
}

export interface CommitTestsTitleProps {
  // The commit's jobs, which name the pick; undefined until they arrive.
  timeline: Timeline | undefined;
  pick: TimelinePick | null;
  onPick: (_pick: TimelinePick | null) => void;
  // The pick's tests by status; undefined while they are on their way
  // (`loading`) or cannot be had.
  counts: StatusCounts | undefined;
  loading: boolean;
  // The one outcome the table lists alone; null for several.
  solo: BundleStatus | null;
  onSelectStatus: (_status: BundleStatus) => void;
  // The timeline's box: the docked title leaves its first row in sight.
  timelineBox: HTMLElement | null;
  // Set by a pick made with a click in the timeline, taken when it lands.
  glide: MutableRefObject<Glide | null>;
  // The table, given what goes at its top: the bar and the counts.
  children: (_top: ReactNode) => ReactNode;
}

// The counts' sizes, largest first: their figures, and the gap between
// counts. The figures stop at the words' size.
const COUNT_SIZES = [
  { figure: 17, gap: 26 },
  { figure: 16, gap: 22 },
  { figure: 15, gap: 18 },
  { figure: 15, gap: 14 },
];
// How much of the timeline's box shows over the docked title: its line, its
// clock and its first row.
const TRAY_NEEDS = 150;
// The narrowest title that docks.
const TRAY_MIN_WIDTH = 760;
const RUN_MILLISECONDS = 420;
const GLIDE_MILLISECONDS = 380;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const MONOSPACE =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const still = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

// A status's color in the bar and the counts' dots: a solid of its hue, or
// the grid's neutral grey for a status without one.
function statusColor(theme: Theme, status: BundleStatus): string {
  const hue = SUMMARY_STATUS_HUES[status];
  return hue === null ? cellStroke(theme, "other") : solidHueColor(theme, hue);
}

function titleSx(theme: Theme) {
  const { text, primary } = theme.palette;
  const band = headerBandColor(theme);
  return {
    "& [hidden]": { display: "none !important" },

    // The line that says what is listed.
    "& .headline": {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      minHeight: 26,
      fontSize: 15,
      color: text.secondary,
    },
    "& .lead": {
      flex: "none",
      marginRight: "2px",
      color: text.primary,
      whiteSpace: "nowrap",
    },
    "& .hint": {
      flex: "none",
      marginLeft: "8px",
      fontSize: 13.5,
      whiteSpace: "nowrap",
    },
    "& .hint.gone": { display: "none" },
    "& .level": {
      display: "inline-flex",
      alignItems: "center",
      flex: "none",
      gap: "6px",
    },
    // The pick itself has what room is left. A name too long for the whole
    // line wraps inside its pill.
    "& .level.keep": { flex: "0 1 auto", minWidth: 0 },
    "& .headline.measuring .level.keep": { flex: "none" },
    "& .headline.measuring .level.keep .step": { whiteSpace: "nowrap" },
    "& .arrow": { color: text.disabled, fontSize: 13 },
    "& .fig": {
      fontWeight: 600,
      color: text.primary,
      letterSpacing: "-0.01em",
      fontVariantNumeric: "tabular-nums",
    },

    // The table's top: the bar, its top edge, and the counts, its first row.
    "& .top": {
      borderLeft: "1px solid var(--table-border-color)",
      borderRight: "1px solid var(--table-border-color)",
      borderRadius: "4px 4px 0 0",
    },
    "& .bar": {
      display: "flex",
      gap: "2px",
      height: 6,
      borderRadius: "3px 3px 0 0",
      overflow: "hidden",
    },
    "& .bar.empty": { background: band },
    // The bar's parts stay in place and stretch: a part with no tests has
    // no width and gives its gap back.
    "& .seg": {
      display: "block",
      flex: "0 1 0%",
      minWidth: 4,
      height: "100%",
      margin: 0,
      padding: 0,
      border: 0,
      cursor: "pointer",
      transition: `flex-grow 420ms ${EASE}, min-width 420ms ${EASE}, margin-left 420ms ${EASE}, opacity 160ms`,
    },
    "& .seg.off": { minWidth: 0, marginLeft: "-2px", pointerEvents: "none" },
    "& .seg:focus-visible": {
      outline: "none",
      boxShadow: `inset 0 0 0 2px ${primary.main}`,
    },
    "@media (prefers-reduced-motion: reduce)": {
      "& .seg": { transition: "none" },
    },
    "& .title-row": {
      display: "flex",
      alignItems: "baseline",
      gap: "16px",
      padding: "10px 12px",
      fontSize: 15,
      lineHeight: "26px",
      color: text.secondary,
    },
    // The counts share one line at the largest of their sizes that fits;
    // past the smallest they wrap.
    "& .counts": {
      display: "flex",
      flex: "1 1 auto",
      flexWrap: "nowrap",
      alignItems: "baseline",
      minWidth: 0,
      gap: "4px var(--gap)",
    },
    "& .counts.wraps": { flexWrap: "wrap" },
    "& .count": {
      display: "inline-flex",
      alignItems: "baseline",
      flex: "none",
      gap: "8px",
      margin: 0,
      padding: 0,
      border: 0,
      borderRadius: "4px",
      background: "none",
      font: "inherit",
      color: "inherit",
      whiteSpace: "nowrap",
      cursor: "pointer",
      transition: "opacity 160ms",
    },
    "& .count:hover": { textDecoration: "underline" },
    "& .count:focus-visible": {
      outline: `2px solid ${primary.main}`,
      outlineOffset: 2,
    },
    "& .counts .fig, & .counts .allpassed": { fontSize: "var(--fig)" },
    // A problem's figure is in its hue's ink.
    "& .count .fig": { color: `var(--ink, ${text.primary})` },
    "& .pip": {
      alignSelf: "center",
      flex: "none",
      width: 8,
      height: 8,
      borderRadius: "50%",
    },
    "& .allpassed": {
      display: "inline-flex",
      alignItems: "baseline",
      flex: "none",
      gap: "6px",
      color: hueColors(theme, "green").text,
      fontWeight: 600,
      whiteSpace: "nowrap",
    },
    "& .allpassed svg": { alignSelf: "center", fontSize: "1.15em" },
    // The counts' total ends their row, at its right.
    "& .total": {
      display: "inline-flex",
      alignItems: "baseline",
      flex: "none",
      gap: "8px",
      marginLeft: "auto",
      whiteSpace: "nowrap",
    },
    // The pointer on a status lights its part of the bar; a status listed
    // alone sends the others back.
    "& .hot .seg:not(.hot)": { opacity: 0.45 },
    "& .solo .seg:not(.solo)": { opacity: 0.2 },
    "& .solo .seg.hot:not(.solo)": { opacity: 0.6 },
    "& .solo .seg.solo": { opacity: 1 },
    "& .solo .count:not(.solo)": { opacity: 0.45 },
    "& .solo .count.hot:not(.solo)": { opacity: 0.8 },
  };
}

// A pill of the line: a level of the pick. Its look is its own, so the copy
// of it that travels from the timeline looks the same off the page.
function Step({
  code = false,
  picked = false,
  tip,
  onClick,
  children,
}: {
  // A file's or a test's name, set as code.
  code?: boolean;
  picked?: boolean;
  tip?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  const sx = {
    display: "inline-flex",
    alignItems: "center",
    minHeight: 26,
    padding: "4px 10px",
    borderRadius: "13px",
    background: picked
      ? timelineColors(theme).selected
      : headerBandColor(theme),
    color: "text.primary",
    fontFamily: code ? MONOSPACE : "inherit",
    fontSize: code ? 12.6 : 14,
    fontWeight: 500,
    lineHeight: "18px",
    letterSpacing: "0.15008px",
    textAlign: "left",
    transition: "background-color 120ms",
    ...(picked
      ? { minWidth: 0, whiteSpace: "normal", overflowWrap: "anywhere" }
      : { whiteSpace: "nowrap" }),
  } as const;
  return onClick === undefined ? (
    <Box component="span" className="step" sx={sx}>
      {children}
    </Box>
  ) : (
    <ButtonBase
      className="step"
      title={tip}
      onClick={onClick}
      sx={{
        ...sx,
        "&:hover": { background: headerBandHoverColor(theme) },
        "&.Mui-focusVisible": {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 2,
        },
      }}
    >
      {children}
    </ButtonBase>
  );
}

// A figure that runs to its new value, so a pick is seen to change the
// counts and not to replace them. It holds the value it ends on until its
// first frame, so a fit made after a change measures it at its widest, and
// on the way it is never wider than that: with fewer digits to come it
// starts from the top of that many (9,999 for 6,045).
function Figure({ value }: { value: number }) {
  const ref = useRef<HTMLElement>(null);
  const shown = useRef(value);
  useIsomorphicLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    element.textContent = integerLabel(value);
    const digits = (figure: number) => String(Math.round(figure)).length;
    let from = shown.current;
    if (from === value || still()) {
      shown.current = value;
      return;
    }
    if (digits(from) > digits(value)) from = 10 ** digits(value) - 1;
    const started = performance.now();
    const step = (now: number) => {
      const progress = Math.max(
        0,
        Math.min(1, (now - started) / RUN_MILLISECONDS)
      );
      shown.current = Math.round(
        from + (value - from) * (1 - (1 - progress) ** 3)
      );
      element.textContent = integerLabel(shown.current);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    let frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <b ref={ref} className="fig" />;
}

// Runs a fit before the first paint and again when one of the elements
// changes size or the fonts arrive. A fit as an element is observed can
// change its height, which the browser reports as an observation loop, so
// those wait for the next frame.
function useFit(
  fit: () => void,
  observed: () => (Element | null)[],
  dependencies: unknown[]
) {
  useIsomorphicLayoutEffect(() => {
    let frame: number | null = null;
    const later = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        fit();
      });
    };
    fit();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
    for (const element of observed()) {
      if (element !== null) observer?.observe(element);
    }
    document.fonts?.ready.then(later, () => undefined);
    return () => {
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
}

interface HeadlineProps {
  // The pick's levels; null while the jobs that name them are on their way.
  levels: ReturnType<typeof trailOf> | null;
  pick: TimelinePick | null;
  onPick: (_pick: TimelinePick | null) => void;
  // The page's own is a heading; the docked one repeats it.
  heading?: boolean;
}

function Headline({ levels, pick, onPick, heading = false }: HeadlineProps) {
  const ref = useRef<HTMLDivElement>(null);
  // What the last fit gave up: the words on how to pick, and the pick's
  // first levels, folded into a count.
  const [fitted, setFitted] = useState({ hintGone: false, folded: 0 });
  useFit(
    () => {
      const headline = ref.current;
      if (headline === null) return;
      // The fit tries each state on the elements themselves and leaves them
      // as it found fit; the state then says the same. The words on how to
      // pick are the first to go.
      const hint = headline.querySelector(".hint");
      hint?.classList.remove("gone");
      const hintGone =
        hint !== null && headline.scrollWidth > headline.clientWidth + 1;
      hint?.classList.toggle("gone", hintGone);
      // The pick's first levels fold into the count until the line holds:
      // it always ends with what was picked.
      const fold = headline.querySelector<HTMLElement>(".fold");
      const levelElements = Array.from(
        headline.querySelectorAll<HTMLElement>(".level")
      );
      let folded = 0;
      if (fold !== null) {
        headline.classList.add("measuring");
        for (const level of levelElements) level.hidden = false;
        fold.hidden = true;
        while (
          headline.scrollWidth > headline.clientWidth + 1 &&
          folded < levelElements.length - 1
        ) {
          levelElements[folded].hidden = true;
          folded += 1;
          fold.hidden = false;
          // The count's own text: the button holds its ripple as well.
          if (fold.firstChild !== null)
            fold.firstChild.nodeValue = `+${folded}`;
        }
        headline.classList.remove("measuring");
      }
      setFitted((previous) =>
        previous.hintGone === hintGone && previous.folded === folded
          ? previous
          : { hintGone, folded }
      );
    },
    () => [ref.current],
    [levels, pick === null]
  );

  const foldedLevels = levels?.slice(0, fitted.folded) ?? [];
  return (
    <div
      ref={ref}
      className="headline"
      {...(heading ? { role: "heading", "aria-level": 2 } : {})}
    >
      <span className="lead">Tests in</span>
      {pick === null ? (
        <>
          <span className="level">
            <Step>{ROOT_NAME}</Step>
          </span>
          <span className={fitted.hintGone ? "hint gone" : "hint"}>
            Click a row above to list its tests
          </span>
        </>
      ) : levels === null ? (
        <Skeleton
          variant="rounded"
          height={26}
          sx={{ width: "16ch", borderRadius: "13px" }}
        />
      ) : (
        <>
          <PointerTip
            title={
              foldedLevels.length === 0 ? null : (
                <>
                  {foldedLevels.map(({ label }, index) => (
                    <Box key={index} sx={{ fontWeight: 600 }}>
                      {index > 0 && "› "}
                      {label}
                    </Box>
                  ))}
                  <Box sx={{ opacity: 0.75, mt: 0.75 }}>
                    Click to go back to{" "}
                    {foldedLevels[foldedLevels.length - 1].label}.
                  </Box>
                </>
              )
            }
          >
            <ButtonBase
              className="step fold"
              hidden={fitted.folded === 0}
              aria-label={`${fitted.folded} earlier ${
                fitted.folded === 1 ? "level" : "levels"
              }: ${foldedLevels.map(({ label }) => label).join(" › ")}`}
              onClick={() =>
                foldedLevels.length > 0 &&
                onPick(foldedLevels[foldedLevels.length - 1].pick)
              }
              sx={(theme) => ({
                flex: "none",
                minHeight: 26,
                padding: "4px 9px",
                borderRadius: "13px",
                background: headerBandColor(theme),
                color: "text.secondary",
                font: "inherit",
                fontSize: 14,
                fontWeight: 500,
                lineHeight: "18px",
                fontVariantNumeric: "tabular-nums",
                "&:hover": { background: headerBandHoverColor(theme) },
              })}
            >
              {`+${fitted.folded}`}
            </ButtonBase>
          </PointerTip>
          {levels.map((level, index) => {
            const last = index === levels.length - 1;
            return (
              <span
                key={index}
                className={last ? "level keep" : "level"}
                hidden={index < fitted.folded}
              >
                {index > 0 && (
                  <span className="arrow" aria-hidden>
                    ›
                  </span>
                )}
                <Step
                  code={level.code}
                  picked={last}
                  tip="Back to this level"
                  onClick={last ? undefined : () => onPick(level.pick)}
                >
                  {level.code ? <Breakable text={level.label} /> : level.label}
                </Step>
                {last && (
                  <ButtonBase
                    title="Clear the selection (Esc steps back)"
                    aria-label="Clear the selection"
                    onClick={() => onPick(null)}
                    sx={(theme) => ({
                      flex: "none",
                      width: 22,
                      height: 22,
                      marginLeft: "2px",
                      borderRadius: "50%",
                      color: "text.secondary",
                      "&:hover": {
                        background: headerBandColor(theme),
                        color: "text.primary",
                      },
                    })}
                  >
                    <CloseIcon sx={{ fontSize: 15 }} />
                  </ButtonBase>
                )}
              </span>
            );
          })}
        </>
      )}
    </div>
  );
}

interface TopProps {
  counts: StatusCounts | undefined;
  // Whether they are the whole commit's: their sum is then called a total.
  whole: boolean;
  loading: boolean;
  solo: BundleStatus | null;
  // The status under the pointer, shared by the table's top and the docked
  // one.
  hot: BundleStatus | null;
  onHot: (_status: BundleStatus | null) => void;
  onSelectStatus: (_status: BundleStatus) => void;
  // What follows the counts in their row: the docked title's way down.
  action?: ReactNode;
}

function Top({
  counts,
  whole,
  loading,
  solo,
  hot,
  onHot,
  onSelectStatus,
  action,
}: TopProps) {
  const theme = useTheme();
  const rowRef = useRef<HTMLDivElement>(null);
  const countsRef = useRef<HTMLDivElement>(null);
  // The counts' size, an index into COUNT_SIZES, and whether they wrap.
  const [fitted, setFitted] = useState({ size: 0, wraps: false });
  useFit(
    () => {
      const counts = countsRef.current;
      if (counts === null) return;
      counts.classList.remove("wraps");
      let size = 0;
      let wraps = true;
      for (; size < COUNT_SIZES.length; size++) {
        counts.style.setProperty("--fig", `${COUNT_SIZES[size].figure}px`);
        counts.style.setProperty("--gap", `${COUNT_SIZES[size].gap}px`);
        if (counts.scrollWidth <= counts.clientWidth + 1) {
          wraps = false;
          break;
        }
      }
      size = Math.min(size, COUNT_SIZES.length - 1);
      counts.classList.toggle("wraps", wraps);
      setFitted((previous) =>
        previous.size === size && previous.wraps === wraps
          ? previous
          : { size, wraps }
      );
    },
    () => [rowRef.current],
    [counts, whole, action !== undefined]
  );

  if (counts === undefined) {
    return (
      <div className="top">
        <Skeleton
          variant="rectangular"
          height={6}
          animation={loading ? "pulse" : false}
          sx={{ borderRadius: "3px 3px 0 0" }}
        />
        <div className="title-row">
          {loading ? (
            <>
              <Skeleton variant="text" sx={{ width: "min(60ch, 70%)" }} />
              <Skeleton variant="text" sx={{ width: "16ch", ml: "auto" }} />
            </>
          ) : (
            "The counts could not be loaded."
          )}
        </div>
      </div>
    );
  }
  const total = countsTotal(counts);
  // The bar's widths as shares of a hundred: parts that grow by less than
  // one in all would leave the bar short.
  const weights = BUNDLE_STATUSES.reduce(
    (sum, status) => sum + barWeight(counts[status]),
    0
  );
  const tip = (status: BundleStatus) =>
    plainTip(
      STATUS_TITLES[status],
      `${integerLabel(counts[status])} of ${countLabel(
        total,
        "test"
      )}, ${shareLabel(counts[status], total)}`,
      solo === status
        ? "Listed alone below. Click to undo."
        : `Click to list ${counts[status] === 1 ? "it" : "them"} alone.`
    );
  const marks = (status: BundleStatus) =>
    `${hot === status ? " hot" : ""}${solo === status ? " solo" : ""}`;
  const pointer = (status: BundleStatus) => ({
    onMouseEnter: () => onHot(status),
    onMouseLeave: () => onHot(null),
    onClick: () => onSelectStatus(status),
  });
  return (
    <div
      className={`top${hot !== null ? " hot" : ""}${
        solo !== null ? " solo" : ""
      }`}
    >
      <div className={total === 0 ? "bar empty" : "bar"}>
        {BUNDLE_STATUSES.map((status) => (
          <PointerTip key={status} title={tip(status)}>
            <button
              type="button"
              className={`seg${counts[status] === 0 ? " off" : ""}${marks(
                status
              )}`}
              style={{
                flexGrow:
                  weights === 0
                    ? 0
                    : (100 * barWeight(counts[status])) / weights,
                background: statusColor(theme, status),
              }}
              tabIndex={counts[status] === 0 ? -1 : undefined}
              aria-label={`${STATUS_TITLES[status]}: ${integerLabel(
                counts[status]
              )} of ${countLabel(total, "test")}, ${shareLabel(
                counts[status],
                total
              )}`}
              {...pointer(status)}
            />
          </PointerTip>
        ))}
      </div>
      <div className="title-row" ref={rowRef}>
        <div
          ref={countsRef}
          className={fitted.wraps ? "counts wraps" : "counts"}
          style={
            {
              "--fig": `${COUNT_SIZES[fitted.size].figure}px`,
              "--gap": `${COUNT_SIZES[fitted.size].gap}px`,
            } as CSSProperties
          }
        >
          {total === 0 ? (
            <span>No tests recorded</span>
          ) : (
            <>
              {allPassed(counts) && (
                <span className="allpassed">
                  <CheckIcon aria-hidden />
                  Every test passed
                </span>
              )}
              {BUNDLE_STATUSES.filter((status) => counts[status] > 0).map(
                (status) => {
                  const hue = problemHue(status);
                  return (
                    <PointerTip key={status} title={tip(status)}>
                      <button
                        type="button"
                        className={`count${marks(status)}`}
                        aria-label={`${integerLabel(
                          counts[status]
                        )} ${statusWord(status)}`}
                        style={
                          hue === null
                            ? undefined
                            : ({
                                "--ink": hueColors(theme, hue).text,
                              } as CSSProperties)
                        }
                        {...pointer(status)}
                      >
                        <i
                          className="pip"
                          style={{ background: statusColor(theme, status) }}
                        />
                        <Figure value={counts[status]} />
                        {statusWord(status)}
                      </button>
                    </PointerTip>
                  );
                }
              )}
              <span className="total">
                <Figure value={total} /> {whole && "total "}
                {total === 1 ? "test" : "tests"}
              </span>
            </>
          )}
        </div>
        {action}
      </div>
    </div>
  );
}

// The name's travel: a copy of the title's pill goes from where the name
// stood in the timeline to the pill, which waits unseen until it lands, in
// the title in sight: the docked one while it is docked.
function fly(
  from: DOMRect,
  pills: HTMLElement[],
  docked: () => boolean,
  backdrop: string
): () => void {
  const [first] = pills;
  if (
    first === undefined ||
    from.width === 0 ||
    from.bottom < 0 ||
    from.top > window.innerHeight
  ) {
    return () => undefined;
  }
  const ghost = first.cloneNode(true) as HTMLElement;
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, {
    position: "fixed",
    left: "0",
    top: "0",
    zIndex: "1400",
    margin: "0",
    pointerEvents: "none",
    willChange: "transform, opacity",
    // The pill's wash over the page's color, and lifted off the page while
    // it travels (--lift runs from 1 to 0).
    background: backdrop,
    boxShadow: `inset 0 0 0 100px ${
      getComputedStyle(first).backgroundColor
    }, 0 6px 18px rgba(0, 0, 0, calc(0.18 * var(--lift, 1)))`,
  });
  document.body.append(ghost);
  for (const pill of pills) pill.style.opacity = "0";
  // The name starts over itself: the pill's padding is taken off its corner.
  const startX = from.left - 10;
  const startY = from.top - 4;
  const began = performance.now();
  let frame = 0;
  const end = () => {
    cancelAnimationFrame(frame);
    ghost.remove();
    for (const pill of pills) pill.style.opacity = "";
  };
  const step = (now: number) => {
    const progress = Math.max(
      0,
      Math.min(1, (now - began) / GLIDE_MILLISECONDS)
    );
    const eased = 1 - (1 - progress) ** 3;
    // The title moves while the timeline opens: the name follows it.
    const target = (
      (docked() ? pills[1] : undefined) ?? first
    ).getBoundingClientRect();
    ghost.style.width = `${target.width}px`;
    ghost.style.transform = `translate(${
      startX + (target.left - startX) * eased
    }px, ${startY + (target.top - startY) * eased}px)`;
    ghost.style.opacity = String(Math.min(1, 0.35 + progress * 4));
    ghost.style.setProperty("--lift", String(1 - eased));
    if (progress < 1 && first.isConnected) frame = requestAnimationFrame(step);
    else end();
  };
  step(began);
  return end;
}

export default function CommitTestsTitle({
  timeline,
  pick,
  onPick,
  counts,
  loading,
  solo,
  onSelectStatus,
  timelineBox,
  glide,
  children,
}: CommitTestsTitleProps) {
  const theme = useTheme();
  const sx = useMemo(() => titleSx(theme), [theme]);
  const [hot, setHot] = useState<BundleStatus | null>(null);
  const levels = useMemo(
    () => (timeline === undefined ? null : trailOf(timeline, pick)),
    [timeline, pick]
  );
  const headingRef = useRef<HTMLDivElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const trayColumnRef = useRef<HTMLDivElement>(null);
  const trayHeadingRef = useRef<HTMLDivElement>(null);

  // Docked while the timeline's first row is in the window, over where the
  // docked title stands, and the table's own title is under it. Not in a
  // title narrower than TRAY_MIN_WIDTH, where it would take too much of the
  // window. Asked of the page as it stands and shown by the tray's own
  // style: as state it would show only after the render that a pick starts.
  const docked = useRef<() => boolean>(() => false);
  useEffect(() => {
    docked.current = () => {
      const own = trayHeadingRef.current;
      const real = headingRef.current;
      if (timelineBox === null || own === null || real === null) return false;
      const ownTop = own.getBoundingClientRect().top;
      return (
        real.getBoundingClientRect().top > ownTop + 0.5 &&
        timelineBox.getBoundingClientRect().top < ownTop - TRAY_NEEDS &&
        own.clientWidth >= TRAY_MIN_WIDTH
      );
    };
    const place = () => {
      const tray = trayRef.current;
      const column = trayColumnRef.current;
      const real = headingRef.current;
      if (tray === null || column === null || real === null) return;
      // At the same place across the page as the table's own title, so one
      // takes over from the other without a jump.
      const realBox = real.getBoundingClientRect();
      column.style.marginLeft = `${realBox.left}px`;
      column.style.width = `${realBox.width}px`;
      tray.style.visibility = docked.current() ? "visible" : "hidden";
    };
    place();
    window.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    // The page grows and shrinks over the title, the timeline above all,
    // and the docked title's own height changes when its counts wrap.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    for (const element of [document.body, trayRef.current]) {
      if (element !== null) observer?.observe(element);
    }
    return () => {
      window.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
      observer?.disconnect();
    };
  }, [timelineBox]);

  // The name travels once the title names the pick it was clicked for.
  const picked = pickKey(pick);
  const background = theme.palette.background.default;
  useIsomorphicLayoutEffect(() => {
    const request = glide.current;
    if (request === null || request.pick !== picked || levels === null) return;
    glide.current = null;
    if (still()) return;
    const pills = [headingRef.current, trayHeadingRef.current].flatMap(
      (heading) =>
        Array.from(
          heading?.querySelectorAll<HTMLElement>(".level.keep .step") ?? []
        )
    );
    return fly(request.from, pills, () => docked.current(), background);
  }, [picked, levels, glide, background]);

  const headline = { levels, pick, onPick };
  const top = {
    counts,
    whole: pick === null,
    loading,
    solo,
    hot,
    onHot: setHot,
    onSelectStatus,
  };
  return (
    <Box>
      <Box ref={headingRef} sx={[sx, { mb: 1.5, scrollMarginTop: "14px" }]}>
        <Headline heading {...headline} />
      </Box>
      {children(
        <Box sx={sx}>
          <Top {...top} />
        </Box>
      )}
      <Box
        ref={trayRef}
        role="region"
        aria-label="The tests the table lists"
        sx={[
          sx,
          {
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: "appBar",
            backgroundColor: "background.default",
            boxShadow: `0 -1px 0 ${
              theme.palette.divider
            }, 0 -12px 28px rgba(0, 0, 0, ${
              theme.palette.mode === "dark" ? 0.4 : 0.09
            })`,
            visibility: "hidden",
          },
        ]}
      >
        <Box ref={trayColumnRef} sx={{ pt: "10px" }}>
          <Box ref={trayHeadingRef} sx={{ mb: 1.5 }}>
            <Headline {...headline} />
          </Box>
          <Top
            {...top}
            action={
              <ButtonBase
                title="Go to the table"
                onClick={() =>
                  headingRef.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  })
                }
                sx={{
                  alignSelf: "center",
                  flex: "none",
                  gap: "4px",
                  height: 26,
                  padding: "0 6px 0 10px",
                  borderRadius: "13px",
                  background: headerBandColor(theme),
                  color: "text.primary",
                  font: "inherit",
                  fontSize: 14,
                  fontWeight: 500,
                  lineHeight: "18px",
                  whiteSpace: "nowrap",
                  transition: "background-color 120ms",
                  "&:hover": { background: headerBandHoverColor(theme) },
                }}
              >
                See the tests
                <KeyboardArrowDownRoundedIcon sx={{ fontSize: 18 }} />
              </ButtonBase>
            }
          />
        </Box>
      </Box>
    </Box>
  );
}
