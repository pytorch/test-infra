import { Box, Tooltip, useTheme } from "@mui/material";
import type { Theme } from "@mui/material/styles";
import dayjs from "dayjs";
import type { JobStep } from "lib/api/tests/commit/jobs/jobs";
import { hueColors } from "lib/tests/blockColors";
import { BUNDLE_STATUS_WORDS } from "lib/tests/bundle";
import { durationLabel, integerLabel } from "lib/tests/table";
import {
  countLabel,
  countsTotal,
  hoursLabel,
  jobVerdict,
  nodeLabel,
  percentLabel,
  Ribbon,
  spanLabel,
  TimelineFile,
  TimelineJob,
  TimelineNode,
  TimelineTest,
  Totals,
} from "lib/tests/timeline";
import { TimelineColors, timelineColors } from "lib/tests/timelineColors";
import { ReactElement, ReactNode, useMemo } from "react";

// What the timeline's tooltips say. Times are in the viewer's time zone.

export const clock = (seconds: number) => dayjs.unix(seconds).format("h:mm a");
export const clockSeconds = (seconds: number) =>
  dayjs.unix(seconds).format("h:mm:ss a");

// The marks of the four things a job's time is: recorded tests, unaccounted
// time, other steps and queue. The key over the timeline draws the same.
export type MarkKind = "tests" | "unaccounted" | "other" | "queue";

export function Swatch({ kind }: { kind: MarkKind }) {
  return <i className={`tl-sw ${kind}`} aria-hidden />;
}

// Hatching over a wash, the mark of unaccounted time.
export const hatchFill = (colors: TimelineColors) =>
  `repeating-linear-gradient(135deg, ${colors.hatch} 0 1.5px, transparent 1.5px 5px), linear-gradient(${colors.hatchWash}, ${colors.hatchWash})`;

// A line of dots, the mark of time spent queued.
export const queueDots = (color: string) =>
  `radial-gradient(circle at 1.5px 50%, ${color} 0 1.2px, transparent 1.6px) 0 0 / 6px 3px round no-repeat`;

// A tooltip's own look: room for a few lines, and the marks drawn for its
// surface, HUD's tooltip grey in either mode.
function tipSx(theme: Theme) {
  const dark = theme.palette.mode === "dark";
  const muted = dark ? "rgba(224, 224, 224, 0.66)" : "rgba(33, 37, 41, 0.6)";
  const colors = timelineColors(theme);
  return {
    maxWidth: 360,
    padding: "9px 11px 10px",
    fontSize: 12.5,
    fontWeight: 400,
    lineHeight: 1.45,
    "--tl-tip-bad": hueColors(theme, "red").text,
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
      backgroundImage: hatchFill(colors),
    },
    "& .tl-sw.queue": {
      width: 15,
      height: 3,
      borderRadius: 0,
      background: queueDots(muted),
    },
  };
}

// A tooltip that follows the pointer and holds a few lines: the timeline's
// rows, its key, and the outcomes of the table's title.
export function PointerTip({
  title,
  children,
}: {
  // Nothing shows for null.
  title: ReactNode;
  children: ReactElement;
}) {
  const theme = useTheme();
  // The same props from one draw to the next: the popper is made again
  // for new ones, and the pointer's every move draws the tooltip.
  const slotProps = useMemo(
    () => ({
      tooltip: { sx: tipSx(theme) },
      popper: {
        modifiers: [{ name: "offset", options: { offset: [12, 14] } }],
      },
    }),
    [theme]
  );
  return (
    <Tooltip
      title={title ?? ""}
      followCursor
      disableInteractive
      enterDelay={0}
      placement="bottom-start"
      slotProps={slotProps}
    >
      {children}
    </Tooltip>
  );
}

function Title({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>{children}</Box>
  );
}

function Line({ children }: { children: ReactNode }) {
  return <Box sx={{ opacity: 0.75, overflowWrap: "anywhere" }}>{children}</Box>;
}

function Hint({ children }: { children: ReactNode }) {
  return children === undefined || children === null ? null : (
    <Box sx={{ opacity: 0.75, mt: 0.75 }}>{children}</Box>
  );
}

// Rows of a name and its figure, the figures in a column.
function Rows({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: "auto auto",
        gap: "1px 14px",
        mt: 0.75,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {rows.map(([name, figure], index) => [
        <Box
          key={`name-${index}`}
          sx={{ display: "flex", alignItems: "center", gap: 0.75 }}
        >
          {name}
        </Box>,
        <Box key={`figure-${index}`} sx={{ textAlign: "right" }}>
          {figure}
        </Box>,
      ])}
    </Box>
  );
}

const bad = { color: "var(--tl-tip-bad)" };

// How a running time splits: tests, unaccounted and other steps.
function splitRows(
  totals: Pick<Totals, "run" | "covered" | "unaccounted" | "other">
): [ReactNode, ReactNode][] {
  const row = (
    kind: MarkKind,
    name: string,
    length: number
  ): [ReactNode, ReactNode][] =>
    length > 0
      ? [
          [
            <>
              <Swatch kind={kind} />
              {name}
            </>,
            <>
              {hoursLabel(length)}{" "}
              <Box component="span" sx={{ opacity: 0.75 }}>
                {percentLabel(length, totals.run)}
              </Box>
            </>,
          ],
        ]
      : [];
  return [
    ...row("tests", "Tests", totals.covered),
    ...row("unaccounted", "Unaccounted", totals.unaccounted),
    ...row("other", "Other steps", totals.other),
  ];
}

// A folded row, with the pointer on its name: its jobs and where their
// running time went, which waits for the jobs' tests.
export function nodeTip(
  node: TimelineNode,
  hint?: string,
  testsPending = false
): ReactNode {
  const { totals } = node;
  const kinds = [
    totals.kinds.tests > 0
      ? `${integerLabel(totals.kinds.tests)} recorded tests`
      : null,
    totals.kinds.untested > 0
      ? `${integerLabel(
          totals.kinds.untested
        )} ran a Test step and recorded none`
      : null,
    totals.kinds.other > 0
      ? `${integerLabel(totals.kinds.other)} ${
          totals.kinds.other === 1 ? "has" : "have"
        } no Test step`
      : null,
  ].filter((kind) => kind !== null);
  return (
    <>
      <Title>{nodeLabel(node)}</Title>
      <Line>
        {countLabel(totals.ran, "job")} ran
        {totals.failed > 0 && (
          <>
            {" · "}
            <Box component="span" sx={bad}>
              {integerLabel(totals.failed)} failed
            </Box>
          </>
        )}
        {totals.flaky > 0 &&
          ` · ${integerLabel(totals.flaky)} with flaky tests`}
        {totals.skipped > 0 && ` · ${integerLabel(totals.skipped)} skipped`}
      </Line>
      {kinds.length > 1 && !testsPending && <Line>{kinds.join(" · ")}</Line>}
      <Rows
        rows={[
          ["Running time", hoursLabel(totals.run)],
          ...(testsPending ? [] : splitRows(totals)),
        ]}
      />
      <Hint>{hint}</Hint>
    </>
  );
}

// A folded row, with the pointer on its ribbon: how many of its jobs were
// running at that time, by what they were doing, which waits for the jobs'
// tests.
export function ribbonTip(
  node: TimelineNode,
  ribbon: Ribbon,
  start: number,
  at: number,
  hint?: string,
  testsPending = false
): ReactNode {
  const slice = Math.min(
    ribbon.slices - 1,
    Math.max(0, Math.floor((at - start) / ribbon.sliceSeconds))
  );
  const tests = ribbon.tests[slice];
  const unaccounted = ribbon.unaccounted[slice];
  const other = ribbon.other[slice];
  const running = tests + unaccounted + other;
  const figure = (value: number) =>
    value >= 10
      ? integerLabel(Math.round(value))
      : value.toFixed(1).replace(/\.0$/, "");
  const rows: [ReactNode, ReactNode][] = [];
  if (tests > 0.05) {
    rows.push([
      <>
        <Swatch kind="tests" />
        In recorded tests
      </>,
      figure(tests),
    ]);
  }
  if (unaccounted > 0.05) {
    rows.push([
      <>
        <Swatch kind="unaccounted" />
        Unaccounted
      </>,
      figure(unaccounted),
    ]);
  }
  if (other > 0.05) {
    rows.push([
      <>
        <Swatch kind="other" />
        Other steps
      </>,
      figure(other),
    ]);
  }
  return (
    <>
      <Title>{nodeLabel(node)}</Title>
      {running < 0.05 ? (
        <Line>At {clock(at)}, nothing was running.</Line>
      ) : (
        <>
          <Line>
            At {clock(at)}, {figure(running)} {running <= 1 ? "job" : "jobs"}{" "}
            running
          </Line>
          {!testsPending && <Rows rows={rows} />}
        </>
      )}
      <Hint>
        {countLabel(node.totals.ran, "job")} in all,{" "}
        {hoursLabel(node.totals.run)} of running time
        {hint === undefined ? "" : `. ${hint}`}
      </Hint>
    </>
  );
}

// A job. What its Test step held waits for the jobs' tests.
export function jobTip(
  job: TimelineJob,
  hint?: string,
  testsPending = false
): ReactNode {
  const verdict = jobVerdict(job);
  const runner = job.job.labels[0];
  if (job.kind === "skipped") {
    return (
      <>
        <Title>{job.job.name}</Title>
        <Hint>Skipped: this job did not run.</Hint>
      </>
    );
  }
  return (
    <>
      <Title>{job.job.name}</Title>
      {runner !== undefined && <Line>{runner}</Line>}
      <Rows
        rows={[
          [
            <Box
              key="verdict"
              component="span"
              sx={verdict.tone === "failed" ? bad : undefined}
            >
              {verdict.text}
            </Box>,
            job.kind === "waiting" ? "" : spanLabel(job.run),
          ],
          ...(job.kind === "waiting"
            ? []
            : ([[`${clock(job.workStart)} – ${clock(job.ended)}`, ""]] as [
                ReactNode,
                ReactNode
              ][])),
          ...(job.queue >= 1
            ? ([
                [
                  <>
                    <Swatch kind="queue" />
                    Queued
                  </>,
                  spanLabel(job.queue),
                ],
              ] as [ReactNode, ReactNode][])
            : []),
          ...(testsPending ? [] : splitRows(job)),
        ]}
      />
      {job.kind === "tests" && job.counts !== null && (
        <Hint>{countLabel(countsTotal(job.counts), "test")} recorded</Hint>
      )}
      {job.kind === "untested" && job.test !== null && !testsPending && (
        <Hint>
          Ran a Test step for {spanLabel(job.test.end - job.test.start)}; no
          test was recorded.
        </Hint>
      )}
      {job.kind === "other" && <Hint>No Test step.</Hint>}
      <Hint>{hint}</Hint>
    </>
  );
}

// A step of an open job. The container step is queue.
export function stepTip(
  step: JobStep & { start: number; end: number },
  number: number,
  count: number
): ReactNode {
  const when = `${clockSeconds(step.start)} – ${clockSeconds(step.end)}`;
  const length = spanLabel(step.end - step.start);
  if (step.name === "Initialize containers") {
    return (
      <>
        <Title>Queued</Title>
        <Line>
          Waited {length} for its container, {when}
        </Line>
        <Hint>
          Step {number} of {count}: {step.name}
        </Hint>
      </>
    );
  }
  return (
    <>
      <Title>{step.name}</Title>
      <Line>
        {step.conclusion === "failure" && (
          <>
            <Box component="span" sx={bad}>
              Failed
            </Box>
            {" · "}
          </>
        )}
        {step.conclusion === "cancelled" && "Cancelled · "}
        {length} · {when}
      </Line>
      <Hint>
        Step {number} of {count}
      </Hint>
    </>
  );
}

export function waitTip(job: TimelineJob): ReactNode {
  return (
    <>
      <Title>Queued</Title>
      <Line>
        Waited {spanLabel(job.started - job.created)} for a runner,{" "}
        {clockSeconds(job.created)} – {clockSeconds(job.started)}
      </Line>
    </>
  );
}

export function fileTip(file: TimelineFile, hint?: string): ReactNode {
  const { failing } = file;
  return (
    <>
      <Title>{file.path === "" ? file.name : file.path}</Title>
      <Line>
        {countLabel(file.tests, "test")} · {spanLabel(file.duration)}
        {file.runs.length > 1 && ` · ${integerLabel(file.runs.length)} runs`}
      </Line>
      <Line>
        {clockSeconds(file.start)} – {clockSeconds(file.end)}
      </Line>
      {(failing > 0 || file.counts.skipped > 0) && (
        <Line>
          {failing > 0 && (
            <>
              <Box component="span" sx={bad}>
                {countLabel(failing, "failing attempt")}
              </Box>
              {file.status === "flaky" && ", passed on a rerun"}
            </>
          )}
          {failing > 0 && file.counts.skipped > 0 && " · "}
          {file.counts.skipped > 0 &&
            `${integerLabel(file.counts.skipped)} skipped`}
        </Line>
      )}
      <Hint>{hint}</Hint>
    </>
  );
}

const ATTEMPT_WORDS = {
  passed: "passed",
  failing: "failed",
  skipped: "skipped",
  other: "other",
};

export function testTip(test: TimelineTest, hint?: string): ReactNode {
  const failed = test.status === "failed" || test.status === "timed_out";
  const duration = test.attempts.reduce(
    (sum, attempt) =>
      attempt.tone === "skipped" ? sum : sum + attempt.end - attempt.start,
    0
  );
  return (
    <>
      <Title>{test.name}</Title>
      {test.suite !== "" && <Line>{test.suite}</Line>}
      <Rows
        rows={[
          [
            <Box key="status" component="span" sx={failed ? bad : undefined}>
              {BUNDLE_STATUS_WORDS[test.status]}
            </Box>,
            test.status === "skipped" ? "" : durationLabel(duration * 1000),
          ],
          ...test.attempts.map((attempt, index): [ReactNode, ReactNode] => [
            test.attempts.length > 1
              ? `Attempt ${index + 1}, ${ATTEMPT_WORDS[attempt.tone]}`
              : "Started",
            clockSeconds(attempt.start),
          ]),
        ]}
      />
      <Hint>{hint}</Hint>
    </>
  );
}

// A name, a line under it and a hint: the rows that fold others away.
export function plainTip(title: string, line?: string, hint?: string) {
  return (
    <>
      <Title>{title}</Title>
      {line !== undefined && <Line>{line}</Line>}
      <Hint>{hint}</Hint>
    </>
  );
}
