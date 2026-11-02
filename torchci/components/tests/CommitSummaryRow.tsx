import CheckIcon from "@mui/icons-material/Check";
import { Box, Skeleton, useTheme } from "@mui/material";
import type { Theme } from "@mui/material/styles";
import type { CommitSummary } from "lib/api/tests/commit/summary/types";
import { hueColors, solidHueColor } from "lib/tests/blockColors";
import type { BundleStatus } from "lib/tests/bundle";
import {
  allPassed,
  COUNT_FIGURE_SIZE,
  countGap,
  fittingCountSize,
  problemHue,
  STATUS_TITLES,
  statusWord,
  SUMMARY_STATUS_HUES,
  SUMMARY_TEXT_SIZE,
  SummaryStatus,
  summaryStatuses,
  timeRangeLabel,
} from "lib/tests/commit";
import { cellStroke } from "lib/tests/gridColors";
import { durationLabel, integerLabel } from "lib/tests/table";
import { useIsomorphicLayoutEffect } from "lib/tests/useIsomorphicLayoutEffect";
import { useMounted } from "lib/tests/useMounted";
import { forwardRef, ReactNode, useRef, useState } from "react";

// The row's measures, in px: the line the counts set, the bar and the
// counts' dots. The counts' figures are COUNT_FIGURE_SIZE, shrinking to the
// facts' SUMMARY_TEXT_SIZE when the line is short of room (fitCounts), both
// from lib/tests/commit.ts.
const LINE = 30;
const BAR_HEIGHT = 12;
const DOT_SIZE = 8;
// The counts group sets its figures' size and the gap between counts as CSS
// variables, so the fit can try sizes in place before one is committed.
const COUNT_SIZE_VARIABLE = "--count-size";
const COUNT_GAP_VARIABLE = "--count-gap";

// The size the counts' figures fit the line at: the width left beside the
// facts, against the counts set on one line at each candidate size
// (fittingCountSize in lib/tests/commit.ts), each tried in place through the
// group's variables, which the committed size takes back after.
function fitCounts(
  row: HTMLElement,
  counts: HTMLElement,
  facts: HTMLElement
): number {
  const columnGap = parseFloat(getComputedStyle(row).columnGap) || 0;
  const available =
    row.getBoundingClientRect().width -
    facts.getBoundingClientRect().width -
    columnGap;
  const children = Array.from(counts.children);
  const size = fittingCountSize(available, (candidate) => {
    counts.style.setProperty(COUNT_SIZE_VARIABLE, `${candidate}px`);
    counts.style.setProperty(COUNT_GAP_VARIABLE, `${countGap(candidate)}px`);
    return children.reduce(
      (width, child) => width + child.getBoundingClientRect().width,
      countGap(candidate) * Math.max(0, children.length - 1)
    );
  });
  counts.style.removeProperty(COUNT_SIZE_VARIABLE);
  counts.style.removeProperty(COUNT_GAP_VARIABLE);
  return size;
}

export interface CommitSummaryRowProps {
  // The summary shown; undefined while there is none.
  summary: CommitSummary | undefined;
  // With no summary: one is on its way, so a skeleton holds the row.
  loading?: boolean;
  // A status clicked, in the counts or the bar: the table lists that
  // outcome alone.
  onSelectStatus: (_status: BundleStatus) => void;
}

// A button that looks like what it holds: no border, no fill, the text as
// around it.
const BARE_BUTTON = {
  border: 0,
  p: 0,
  m: 0,
  background: "none",
  font: "inherit",
  color: "inherit",
  cursor: "pointer",
  textAlign: "left" as const,
};

// A status's color in the counts' dots and the bar: a solid of its hue, or
// the grid's neutral grey for a status without one.
function statusColor(theme: Theme, status: BundleStatus): string {
  const hue = SUMMARY_STATUS_HUES[status];
  return hue === null ? cellStroke(theme, "other") : solidHueColor(theme, hue);
}

// A count's color: a problem status's count is in its hue's ink, the others
// in the page's.
function countColor(theme: Theme, status: BundleStatus): string {
  const hue = problemHue(status);
  return hue === null ? theme.palette.text.primary : hueColors(theme, hue).text;
}

// The ring a button shows under the keyboard; inset, since the bar clips.
function focusRing(theme: Theme) {
  return {
    outline: "none",
    boxShadow: `inset 0 0 0 2px ${theme.palette.primary.main}`,
  };
}

// A figure among the facts, "672,763 unique tests".
function Fact({ value, word }: { value: string; word?: string }) {
  return (
    <Box component="span">
      <Box component="b" sx={{ fontWeight: 500, color: "text.primary" }}>
        {value}
      </Box>
      {word !== undefined && ` ${word}`}
    </Box>
  );
}

function Separator() {
  return (
    <Box component="span" aria-hidden sx={{ color: "text.disabled", mx: 1.25 }}>
      ·
    </Box>
  );
}

// The facts at the right of the counts: the total tests, the unique tests,
// the jobs, and the wall time with its span in the viewer's time zone, which
// only the client can say (mounted, the row's useMounted, so the row can
// refit its counts as the range appears). The ref is for that fit, which
// measures the facts.
const Facts = forwardRef<
  HTMLDivElement,
  { summary: CommitSummary; mounted: boolean }
>(function Facts({ summary, mounted }, ref) {
  const { total } = summary.counts;
  const first = summary.first_started_at;
  const last = summary.last_ended_at;
  const wall =
    first === null || last === null
      ? "—"
      : durationLabel(Math.max(0, Date.parse(last) - Date.parse(first)));
  const range =
    mounted && first !== null && last !== null
      ? timeRangeLabel(first, last)
      : null;
  return (
    <Box
      ref={ref}
      sx={{
        ml: "auto",
        fontSize: SUMMARY_TEXT_SIZE,
        color: "text.secondary",
        whiteSpace: "nowrap",
      }}
    >
      <Fact
        value={integerLabel(total.runs)}
        word={total.runs === 1 ? "total test" : "total tests"}
      />
      <Separator />
      <Fact
        value={integerLabel(total.tests)}
        word={total.tests === 1 ? "unique test" : "unique tests"}
      />
      <Separator />
      <Fact
        value={integerLabel(total.jobs)}
        word={total.jobs === 1 ? "job" : "jobs"}
      />
      <Separator />
      <Fact value={wall} />
      {range !== null && (
        <Box component="span" sx={{ color: "text.disabled", ml: 1 }}>
          {range}
        </Box>
      )}
    </Box>
  );
});

// The bar: one segment per status with runs, each a button that lists the
// outcome alone, as wide as its weight says (summaryStatuses in
// lib/tests/commit.ts: the logarithm of its runs, so the bar is not to
// scale) and never under 4px. The title gives the true share.
function Bar({
  theme,
  statuses,
  total,
  onSelectStatus,
}: {
  theme: Theme;
  statuses: SummaryStatus[];
  total: number;
  onSelectStatus: (_status: BundleStatus) => void;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        gap: "2px",
        height: BAR_HEIGHT,
        mt: 2,
        borderRadius: `${BAR_HEIGHT / 2}px`,
        overflow: "hidden",
      }}
    >
      {statuses.map(({ status, counts, weight, share }) => {
        const label = `${STATUS_TITLES[status]}: ${integerLabel(
          counts.runs
        )} of ${integerLabel(total)} tests, ${share}`;
        return (
          <Box
            key={status}
            component="button"
            type="button"
            title={label}
            aria-label={label}
            onClick={() => onSelectStatus(status)}
            sx={{
              ...BARE_BUTTON,
              display: "block",
              flex: `${weight} 1 0%`,
              minWidth: 4,
              height: "100%",
              backgroundColor: statusColor(theme, status),
              "&:hover": { opacity: 0.8 },
              "&:focus-visible": focusRing(theme),
            }}
          />
        );
      })}
    </Box>
  );
}

// One count: a dot of the status's color, its figure large and its word, a
// button that lists the outcome alone.
function Count({
  theme,
  status,
  runs,
  onSelectStatus,
}: {
  theme: Theme;
  status: BundleStatus;
  runs: number;
  onSelectStatus: (_status: BundleStatus) => void;
}) {
  return (
    <Box
      component="button"
      type="button"
      onClick={() => onSelectStatus(status)}
      sx={{
        ...BARE_BUTTON,
        display: "inline-flex",
        alignItems: "baseline",
        gap: 1,
        whiteSpace: "nowrap",
        borderRadius: "4px",
        "&:hover": { textDecoration: "underline" },
        "&:focus-visible": focusRing(theme),
      }}
    >
      <Box
        component="span"
        aria-hidden
        sx={{
          display: "inline-block",
          flex: "none",
          alignSelf: "center",
          width: DOT_SIZE,
          height: DOT_SIZE,
          borderRadius: "50%",
          backgroundColor: statusColor(theme, status),
        }}
      />
      <Box
        component="b"
        sx={{
          fontSize: `var(${COUNT_SIZE_VARIABLE})`,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: countColor(theme, status),
        }}
      >
        {integerLabel(runs)}
      </Box>
      {statusWord(status)}
    </Box>
  );
}

// Two lines as wide as the table, saying what happened to the commit's
// tests. The counts line: at left the statuses with runs, "5 failed · 8
// timed out · 87 flaky · 4,721,574 passed …", each figure large, led by a
// green "Every test passed" when nothing failed, timed out or was flaky; at
// right the facts, the total tests, the unique tests, the jobs and the wall
// time. When the line is short of room for both, the figures shrink a pixel
// at a time, the gaps between counts with them, down to the facts' size, and
// only past that do the facts drop under the counts. Under it a bar of the
// statuses with runs. The figures count runs and call them tests, a test run
// in several jobs once per job, so the counts add up to the total tests; the
// unique tests count each once. A status clicked, in the counts or the bar,
// has the table list that outcome alone.
export default function CommitSummaryRow({
  summary,
  loading = false,
  onSelectStatus,
}: CommitSummaryRowProps) {
  const theme = useTheme();
  // Whether the client has rendered: the facts show their time range from
  // then on, and the counts are refitted beside it in the same pass.
  const mounted = useMounted();
  const rowRef = useRef<HTMLDivElement>(null);
  const countsRef = useRef<HTMLDivElement>(null);
  const factsRef = useRef<HTMLDivElement>(null);
  // The figures' size: fitted before the row is painted, again as the facts
  // gain their time range on mount, and when the row or the facts resize or
  // the fonts arrive.
  const [figureSize, setFigureSize] = useState(COUNT_FIGURE_SIZE);
  useIsomorphicLayoutEffect(() => {
    const row = rowRef.current;
    const counts = countsRef.current;
    const facts = factsRef.current;
    if (row === null || counts === null || facts === null) return;
    let active = true;
    let frame: number | null = null;
    const fit = () => {
      if (active) setFigureSize(fitCounts(row, counts, facts));
    };
    // A fit on the next frame: one made as the row is observed can move the
    // facts between lines, a change of the row's height the browser would
    // report as an observation loop.
    const fitNextFrame = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        fit();
      });
    };
    fit();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(fitNextFrame);
    observer?.observe(row);
    observer?.observe(facts);
    document.fonts?.ready.then(fitNextFrame, () => undefined);
    return () => {
      active = false;
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [summary, mounted]);
  if (summary === undefined) {
    if (!loading) return null;
    return (
      <Box aria-hidden>
        <Skeleton
          variant="text"
          width="70%"
          sx={{ fontSize: COUNT_FIGURE_SIZE, lineHeight: `${LINE}px` }}
        />
        <Skeleton
          variant="rounded"
          height={BAR_HEIGHT}
          sx={{ mt: 2, borderRadius: `${BAR_HEIGHT / 2}px` }}
        />
      </Box>
    );
  }
  const statuses = summaryStatuses(summary.counts);
  const counts: ReactNode[] = statuses.map(({ status, counts }) => (
    <Count
      key={status}
      theme={theme}
      status={status}
      runs={counts.runs}
      onSelectStatus={onSelectStatus}
    />
  ));
  return (
    <Box component="section" aria-label="Test summary">
      <Box
        ref={rowRef}
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          justifyContent: "space-between",
          columnGap: 4,
          rowGap: 1,
          lineHeight: `${LINE}px`,
          fontSize: SUMMARY_TEXT_SIZE,
          color: "text.secondary",
        }}
      >
        <Box
          ref={countsRef}
          sx={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "baseline",
            gap: `8px var(${COUNT_GAP_VARIABLE})`,
            [COUNT_SIZE_VARIABLE]: `${figureSize}px`,
            [COUNT_GAP_VARIABLE]: `${countGap(figureSize)}px`,
          }}
        >
          {allPassed(summary.counts) && (
            <Box
              component="span"
              sx={{
                display: "inline-flex",
                alignItems: "center",
                gap: 1,
                fontSize: `var(${COUNT_SIZE_VARIABLE})`,
                color: hueColors(theme, "green").text,
                fontWeight: 600,
              }}
            >
              <CheckIcon aria-hidden sx={{ fontSize: "1.1em" }} />
              Every test passed
            </Box>
          )}
          {counts}
        </Box>
        <Facts ref={factsRef} summary={summary} mounted={mounted} />
      </Box>
      {statuses.length > 0 && (
        <Bar
          theme={theme}
          statuses={statuses}
          total={summary.counts.total.runs}
          onSelectStatus={onSelectStatus}
        />
      )}
    </Box>
  );
}
