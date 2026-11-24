import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import {
  Box,
  Skeleton,
  type Theme,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import LoadError from "components/tests/LoadError";
import {
  type CostCoverage,
  type CostCoverageJobs,
  costCoverageJobsUrl,
  costCoverageUrl,
  costUnit,
  type CoverageBannerProps,
  type DayRange,
  jobsWindow,
  within,
} from "lib/api/tests/cost/contracts";
import { hatch } from "lib/tests/cost/colors";
import {
  bracketLabel,
  clampWarning,
  coverageDetails,
  coverageEmpty,
  coverageHull,
  type CoverageStrip,
  coverageStrip,
  coverageWhat,
  coverageWhen,
  defaultBannerRange,
  GREY_GUESS,
  greyShare,
  jobsSource,
  type JobsState,
  outsideSplit,
  partWhat,
  pctLabel,
  segmentLabels,
  type StripPart,
  type StripSegment,
  testDays,
} from "lib/tests/cost/coverage";
import { amountLabel, shareLabel } from "lib/tests/cost/query";
import { useSettled } from "lib/tests/cost/useSettled";
import { HEADER_TITLE_STYLE } from "lib/tests/layout";
import { useApiResource } from "lib/tests/useApiResource";
import { useEffect, useMemo, useRef, useState } from "react";

// The strip's fills, two ordinal ramps: greys for what the page leaves out,
// blues for what it covers, each mode its own steps. ink = the label inside,
// white or near-black, whichever reads better on the fill (APCA). The ghost
// (outside job time) takes the theme's faint text tints instead.
type Fill = { fill: string; ink: string };
const FILLS: Record<
  "light" | "dark",
  Record<Exclude<StripPart, "outside_jobs">, Fill>
> = {
  light: {
    other_repos: { fill: "#959595", ink: "#ffffff" },
    builds: { fill: "#777777", ink: "#ffffff" },
    outside_view: { fill: "#b3b3b3", ink: "#0b0b0b" },
    no_reports: { fill: "#86b6ef", ink: "#0b0b0b" },
    setup_idle: { fill: "#3987e5", ink: "#ffffff" },
    running: { fill: "#1c5cab", ink: "#ffffff" },
  },
  dark: {
    other_repos: { fill: "#686868", ink: "#ffffff" },
    builds: { fill: "#828282", ink: "#ffffff" },
    outside_view: { fill: "#515151", ink: "#ffffff" },
    no_reports: { fill: "#184f95", ink: "#ffffff" },
    setup_idle: { fill: "#2a78d6", ink: "#ffffff" },
    running: { fill: "#86b6ef", ink: "#0b0b0b" },
  },
};

const STRIP_HEIGHT = 20;
const BRACKET_HEIGHT = 16;
// A label's width at 12px semibold, so a segment's label steps down
// (segmentLabels) before it clips. Server markup uses a rough per-character
// width; once mounted, the browser measures the text in the theme's font.
const labelWidth = (text: string) => Math.ceil(text.length * 6.1);
let measureCtx: CanvasRenderingContext2D | null | undefined;
function measuredWidth(text: string, fontFamily: string): number {
  if (typeof document === "undefined") return labelWidth(text);
  if (measureCtx === undefined) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  if (!measureCtx) return labelWidth(text);
  measureCtx.font = `600 12px ${fontFamily}`;
  return Math.ceil(measureCtx.measureText(text).width) + 1;
}

// The answer this banner can slice B from: the right repository and scope,
// covering every day it needs; a kept answer still serves while it covers.
function covering(
  data: CostCoverage | undefined,
  repo: string | undefined,
  workflows: readonly string[],
  range: DayRange | null
): CostCoverage | undefined {
  if (data === undefined || range === null || data.repo !== repo) return;
  const asked = [...workflows].sort().join(",");
  if ([...data.workflows].sort().join(",") !== asked) return;
  return within(range, { from: data.from, to: data.to }) ? data : undefined;
}

function coveringJobs(
  data: CostCoverageJobs | undefined,
  repo: string | undefined,
  need: DayRange | null
): CostCoverageJobs | undefined {
  if (data === undefined || need === null || data.repo !== repo) return;
  return within(need, { from: data.from, to: data.to }) ? data : undefined;
}

interface BannerData {
  strip: CoverageStrip | null; // null until the test answer covers B
  jobs: JobsState;
  isB: boolean;
  error: unknown;
  retry: () => void;
}

// The banner's two requests: /coverage for the hull of the bars
// shown and B, sliced to B here, so B moves within the chart without a
// request; /coverage/jobs for the fixed 14-day window, once, and for a B
// outside it (its days with test data, up to 28) only after B has held
// still for 800 ms.
export function useCoverageBanner({
  repo,
  workflows,
  b,
  shown,
  end,
  unit,
  pricer,
}: CoverageBannerProps): BannerData {
  const range = b ?? (end === null ? null : defaultBannerRange(end));
  const hull = range === null ? null : coverageHull(shown, range);
  const coverageUrl = useSettled(
    repo !== undefined && hull !== null
      ? costCoverageUrl(repo, workflows, hull)
      : null,
    400,
    String
  );
  const tests = useApiResource<CostCoverage>(coverageUrl, {
    keepPreviousData: true,
  });
  const windowUrl =
    repo !== undefined && end !== null
      ? costCoverageJobsUrl(repo, jobsWindow(end))
      : null;
  const windowJobs = useApiResource<CostCoverageJobs>(windowUrl, {
    keepPreviousData: true,
  });
  const settledRange = useSettled(range, 800);
  const settledTests = covering(tests.data, repo, workflows, settledRange);
  const settledNeed =
    settledTests && settledRange ? testDays(settledTests, settledRange) : null;
  const exactUrl =
    repo !== undefined &&
    end !== null &&
    settledNeed !== null &&
    jobsSource(settledNeed, end) === "exact"
      ? costCoverageJobsUrl(repo, settledNeed)
      : null;
  const exactJobs = useApiResource<CostCoverageJobs>(exactUrl, {
    keepPreviousData: true,
  });

  const data = covering(tests.data, repo, workflows, range);
  const need = data && range ? testDays(data, range) : null;
  const source = need !== null && end !== null ? jobsSource(need, end) : null;
  const res = source === "exact" ? exactJobs : windowJobs;
  const jobs =
    source === null || source === "too_long"
      ? undefined
      : coveringJobs(res.data, repo, need);
  // B's test days need job hours; until end is known (and so their source)
  // they are still counting, never "only this repository's".
  const jobsState: JobsState =
    source === "too_long"
      ? "too_long"
      : jobs !== undefined || need === null
      ? "ok"
      : res.error !== undefined
      ? "error"
      : "loading";
  const from = range?.from;
  const to = range?.to;
  const strip = useMemo(
    () =>
      data === undefined || from === undefined || to === undefined
        ? null
        : coverageStrip(data, jobs ?? null, { from, to }, pricer, unit),
    [data, jobs, from, to, pricer, unit]
  );
  return {
    strip,
    jobs: jobsState,
    isB: b !== null,
    error: data === undefined ? tests.error : undefined,
    retry: () => void tests.retry(),
  };
}

function segmentTitle(strip: CoverageStrip, s: StripSegment): string {
  const unit = costUnit(strip.unit);
  const page =
    s.page && strip.page > 0
      ? ` · ${shareLabel(s.value / strip.page)} of this page`
      : "";
  const whole =
    strip.outside !== null
      ? "total AWS spend"
      : strip.base === "org"
      ? "org CI"
      : `${strip.repo} test jobs`;
  const hours =
    strip.unit === "usd" && s.part !== "outside_jobs"
      ? ` (${amountLabel("hours", s.hours)})`
      : "";
  const what =
    s.part === "outside_jobs" && outsideSplit(strip) !== ""
      ? `${outsideSplit(strip).slice(2)}.`
      : partWhat(s.part, strip.repo);
  return `${s.name} · ${amountLabel(unit, s.value)}${hours} · ${pctLabel(
    s
  )} of ${whole}${page}: ${what}`;
}

// The ⓘ at the strip's right end: the banner's definitions and caveats, one
// fact a row, on hover or focus only.
function DetailsTip({ lines }: { lines: readonly string[] }) {
  return (
    <Tooltip
      enterDelay={150}
      placement="bottom-end"
      slotProps={{
        tooltip: { sx: { maxWidth: 460 } },
        // Below the bracket, not over its label.
        popper: {
          modifiers: [{ name: "offset", options: { offset: [0, 8] } }],
        },
      }}
      title={
        <Box
          component="ul"
          sx={{
            m: 0,
            p: 0,
            listStyle: "none",
            display: "grid",
            rowGap: "4px",
          }}
        >
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </Box>
      }
    >
      <Box
        component="span"
        role="img"
        tabIndex={0}
        data-details
        aria-label={`About this strip: ${lines.join(" ")}`}
        sx={{
          display: "inline-flex",
          color: "text.secondary",
          cursor: "help",
          "&:focus-visible": {
            outline: (theme) => `2px solid ${theme.palette.primary.main}`,
            borderRadius: "50%",
          },
        }}
      >
        <InfoOutlinedIcon sx={{ fontSize: "0.9rem" }} />
      </Box>
    </Tooltip>
  );
}

// A label that steps down to shorter texts as its box narrows, then to
// nothing: a container query per text, so it holds under SSR and on resize
// without measuring the box. pad = the box's width around the text.
function FitLabel({
  texts,
  pad,
  measure,
}: {
  texts: readonly string[];
  pad: number;
  measure: (_text: string) => number;
}) {
  const widths = texts.map((t) => measure(t) + pad);
  return (
    <Box
      component="span"
      sx={{
        whiteSpace: "nowrap",
        fontSize: "0.75rem",
        fontWeight: 600,
        px: "6px",
      }}
    >
      {texts.map((text, i) =>
        text === "" ? null : (
          <Box
            key={i}
            component="span"
            aria-hidden={i > 0 ? true : undefined}
            sx={{
              ...(i > 0 && {
                display: "none",
                [`@container (max-width: ${widths[i - 1]}px)`]: {
                  display: "inline",
                },
              }),
              [`@container (max-width: ${widths[i]}px)`]: { display: "none" },
            }}
          >
            {text}
          </Box>
        )
      )}
    </Box>
  );
}

const block = {
  minWidth: 0,
  height: STRIP_HEIGHT,
  borderRadius: "4px",
  overflow: "hidden",
  containerType: "inline-size",
  display: "flex",
  alignItems: "center",
  lineHeight: `${STRIP_HEIGHT}px`,
  "&:focus-visible": {
    outline: (theme: Theme) => `2px solid ${theme.palette.primary.main}`,
    outlineOffset: 1,
  },
} as const;

// The bracket under this page's blue parts: two short ticks up to the
// strip, a hairline, and its label centred on the line.
function Bracket({
  texts,
  measure,
  column,
}: {
  texts: readonly string[];
  measure: (_text: string) => number;
  column: string;
}) {
  const theme = useTheme();
  const line = `1px solid ${alpha(
    theme.palette.text.primary,
    theme.palette.mode === "dark" ? 0.45 : 0.4
  )}`;
  const arm = {
    flex: "1 1 0",
    minWidth: 8,
    height: BRACKET_HEIGHT / 2,
    borderBottom: line,
  } as const;
  return (
    <Box
      data-bracket
      aria-hidden
      sx={{
        gridColumn: column,
        containerType: "inline-size",
        display: "flex",
        alignItems: "flex-start",
        height: BRACKET_HEIGHT,
        lineHeight: `${BRACKET_HEIGHT}px`,
        color: "text.secondary",
      }}
    >
      <Box sx={{ ...arm, borderLeft: line, borderBottomLeftRadius: "4px" }} />
      <FitLabel texts={texts} pad={12 + 16} measure={measure} />
      <Box sx={{ ...arm, borderRight: line, borderBottomRightRadius: "4px" }} />
    </Box>
  );
}

// The strip: one 20px row of blocks, widths by share, 2px of page between
// them, and the ⓘ at its right end; under it, one bracket over this page's
// blue parts (or why the strip is empty), on the same columns. While the job
// hours are on their way, a striped "counting…" block holds their last width
// (pending) and the rest scales into what is left.
export function CoverageStripView({
  strip,
  pending,
  dim,
  details,
}: {
  strip: CoverageStrip | null;
  pending: number | null;
  dim: boolean;
  details: readonly string[];
}) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const fills = FILLS[theme.palette.mode];
  const ghost: Fill = {
    fill: alpha(theme.palette.text.primary, dark ? 0.07 : 0.045),
    ink: theme.palette.text.secondary,
  };
  const ghostBorder = `1px dashed ${alpha(
    theme.palette.text.primary,
    dark ? 0.32 : 0.28
  )}`;
  // Measure label text only once mounted, so server and first client markup
  // agree.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const font = theme.typography.fontFamily ?? "sans-serif";
  const measure = (text: string) =>
    mounted ? measuredWidth(text, font) : labelWidth(text);
  const pale = alpha(theme.palette.text.primary, dark ? 0.14 : 0.08);
  const shown = strip?.segments.filter((s) => s.value > 0) ?? [];
  const info = (
    <Box sx={{ display: "flex", alignItems: "center", height: STRIP_HEIGHT }}>
      <DetailsTip lines={details} />
    </Box>
  );
  const layout = {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 20px",
    rowGap: "2px",
    opacity: dim ? 0.5 : 1,
    transition: "opacity 150ms",
  } as const;
  const empty = strip === null ? null : coverageEmpty(strip);
  if (strip === null || shown.length === 0) {
    return (
      <Box sx={layout}>
        <Box
          sx={{
            height: STRIP_HEIGHT,
            borderRadius: "4px",
            backgroundColor: pale,
          }}
        />
        {info}
        <Box
          sx={{
            height: BRACKET_HEIGHT,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {empty !== null ? (
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {empty}
            </Typography>
          ) : (
            strip === null && (
              <Skeleton
                aria-hidden
                variant="rounded"
                height={8}
                sx={{ width: "24%" }}
              />
            )
          )}
        </Box>
      </Box>
    );
  }
  const scale = pending === null ? 1 : 1 - pending;
  const cols = [
    ...(pending === null ? [] : [pending]),
    ...shown.map((s) => s.share * scale),
  ];
  // Every column at least 2px; fr weights ×1000, so they never sum under 1.
  const columns = {
    display: "grid",
    gridTemplateColumns: cols
      .map((c) => `minmax(2px, ${Number((c * 1000).toFixed(3))}fr)`)
      .join(" "),
    columnGap: "2px",
  } as const;
  const offset = pending === null ? 1 : 2;
  const first = shown.findIndex((s) => s.page);
  const last = shown.length - 1 - [...shown].reverse().findIndex((s) => s.page);
  const bracket = bracketLabel(strip);
  const texts =
    bracket === null ? [] : [bracket.full, bracket.short, bracket.tiny];
  const label = shown
    .map(
      (s) =>
        `${s.name} ${amountLabel(costUnit(strip.unit), s.value)} (${pctLabel(
          s
        )})`
    )
    .join(", ");
  return (
    <Box sx={layout}>
      <Box
        role="img"
        aria-label={`What this page covers: ${label}${
          bracket === null ? "" : `; ${bracket.full}`
        }`}
        sx={columns}
      >
        {pending !== null && (
          <Tooltip
            title="Counting the organization's job hours for these days…"
            enterDelay={300}
          >
            <Box
              sx={{
                ...block,
                backgroundColor: pale,
                backgroundImage: hatch(alpha(theme.palette.text.primary, 0.12)),
                color: "text.secondary",
              }}
            >
              <FitLabel texts={["counting…", "…"]} pad={12} measure={measure} />
            </Box>
          </Tooltip>
        )}
        {shown.map((s) => {
          const isGhost = s.part === "outside_jobs";
          const fill = isGhost ? ghost : fills[s.part as keyof typeof fills];
          return (
            <Tooltip
              key={s.part}
              title={segmentTitle(strip, s)}
              enterDelay={300}
              slotProps={{ tooltip: { sx: { maxWidth: 420 } } }}
            >
              <Box
                tabIndex={0}
                data-part={s.part}
                sx={{
                  ...block,
                  backgroundColor: fill.fill,
                  color: fill.ink,
                  ...(isGhost && {
                    border: ghostBorder,
                    boxSizing: "border-box",
                  }),
                }}
              >
                <FitLabel
                  texts={segmentLabels(s, pending !== null)}
                  pad={12}
                  measure={measure}
                />
              </Box>
            </Tooltip>
          );
        })}
      </Box>
      {info}
      <Box sx={{ ...columns, height: BRACKET_HEIGHT }}>
        {first >= 0 && bracket !== null && (
          <Bracket
            texts={texts}
            measure={measure}
            column={`${offset + first} / ${offset + last + 1}`}
          />
        )}
      </Box>
    </Box>
  );
}

// What share of the organization's CI runner-hours this page
// covers over B's days, in one strip, one bracket over this page's part and
// an ⓘ holding the definitions. The unit follows the page's Hours/$ toggle;
// the scope is the repository and the workflow scope (not the drill trail).
// In $ with rates-file totals the strip's whole is the AWS bill.
export default function CoverageBanner(props: CoverageBannerProps) {
  const data = useCoverageBanner(props);
  // The last strip drawn, kept while a new B's test answer loads, and the
  // grey share the job hours took in it, kept while they load.
  const last = useRef<CoverageStrip | null>(null);
  const grey = useRef<number | null>(null);
  if (data.strip !== null) last.current = data.strip;
  const strip = data.strip ?? last.current;
  const lastGrey = data.strip === null ? null : greyShare(data.strip);
  if (lastGrey !== null) grey.current = lastGrey;
  const warning = data.strip === null ? null : clampWarning(data.strip);
  useEffect(() => {
    // eslint-disable-next-line no-console
    if (warning !== null) console.warn(warning);
  }, [warning]);
  const pending =
    data.strip !== null && data.jobs === "loading"
      ? grey.current ?? GREY_GUESS
      : null;
  return (
    <Box component="section" aria-label="What this page covers">
      <Box
        sx={{
          display: "flex",
          alignItems: "baseline",
          gap: 1,
          mb: 0.5,
          minHeight: 22,
        }}
      >
        <Typography
          component="h2"
          sx={{
            ...HEADER_TITLE_STYLE,
            fontSize: "0.75rem",
            color: "text.secondary",
            whiteSpace: "nowrap",
          }}
        >
          {strip === null ? "What this page covers" : coverageWhat(strip)}
        </Typography>
        <Typography
          component="span"
          variant="body2"
          sx={{
            color: "text.secondary",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {strip === null ? "" : coverageWhen(strip, data.isB)}
        </Typography>
      </Box>
      {data.error !== undefined && strip === null ? (
        <LoadError
          what="what this page covers"
          error={data.error}
          onRetry={data.retry}
        />
      ) : (
        <CoverageStripView
          strip={strip}
          pending={pending}
          dim={data.strip === null}
          details={coverageDetails(strip, data.jobs)}
        />
      )}
    </Box>
  );
}
