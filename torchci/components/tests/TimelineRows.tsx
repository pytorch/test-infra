import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { Collapse, Skeleton } from "@mui/material";
import LoadError from "components/tests/LoadError";
import { Breakable } from "components/tests/TestName";
import TextLink from "components/tests/TextLink";
import {
  fileTip,
  jobTip,
  nodeTip,
  plainTip,
  ribbonTip,
  stepTip,
  testTip,
  waitTip,
} from "components/tests/TimelineTips";
import { durationLabel, integerLabel } from "lib/tests/table";
import {
  bandPath,
  countLabel,
  countsTotal,
  hoursLabel,
  jobNodeId,
  jobVerdict,
  LISTED_TESTS,
  namedFiles,
  nodeLabel,
  otherFiles,
  OtherRows,
  Ribbon,
  ribbonOf,
  rowsOnWay,
  rowsUnder,
  spanLabel,
  stepAt,
  stepCuts,
  Timeline,
  TimelineFile,
  timelineFiles,
  TimelineJob,
  TimelineNode,
  TimelinePick,
  TimelineStep,
  TimelineTest,
  timelineTest,
} from "lib/tests/timeline";
import { useFileTests, useJobDetail } from "lib/tests/useCommitJobs";
import {
  createContext,
  KeyboardEvent,
  memo,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";

// The rows of the commit page's timeline (CommitTimeline): a row is a name
// at the left and a track on the clock at the right. A folded row's track
// is a ribbon, as tall at each minute as the jobs then running; a job's is
// a bar, cut into its steps while the job is open; and inside a job its
// test files and their tests are bars on the same clock.

// What a row's tooltip says with the pointer at a time on its track, or on
// its name (null).
export type TipDescriber = (_at: number | null) => ReactNode;

// A row that was clicked.
export type RowTarget =
  | { kind: "node"; node: TimelineNode }
  // A line of rows folded away while a job is open, by its row ID.
  | { kind: "others"; id: string }
  | { kind: "files"; job: TimelineJob; files: TimelineFile[] }
  | { kind: "file"; job: TimelineJob; file: TimelineFile }
  | { kind: "test"; job: TimelineJob; file: TimelineFile; test: TimelineTest };

export interface TimelineRowsContext {
  repo: string;
  sha: string;
  timeline: Timeline;
  pick: TimelinePick | null;
  // The rows open by choice: every job's row, the smaller workflows', the
  // bots', a job's shorter files' (by job ID), and the lines of rows folded
  // away while a job is open.
  open: ReadonlySet<string>;
  // The rows from the first down to the pick, by ID, and the pick's own
  // when it is a workflow, a build or a job.
  onPath: ReadonlySet<string>;
  pickedId: string | null;
  // A job is open: only the way down to the pick is listed, the other rows
  // of each level folded into a line, and the rows outside the pick are
  // drawn in grey.
  focused: boolean;
  onActivate: (_target: RowTarget, _row: HTMLElement) => void;
  tips: Map<string, TipDescriber>;
  // The open job's steps, once they have loaded.
  steps: TimelineStep[] | null;
}

export const RowsContext = createContext<TimelineRowsContext | null>(null);

function useRows(): TimelineRowsContext {
  const context = useContext(RowsContext);
  if (context === null) throw new Error("a timeline row outside a timeline");
  return context;
}

// A row's tooltip, for as long as the row is drawn: it says what the row
// last drew.
function useTip(id: string, describe: TipDescriber) {
  const { tips } = useRows();
  const latest = useRef(describe);
  latest.current = describe;
  useEffect(() => {
    tips.set(id, (at) => latest.current(at));
    return () => {
      tips.delete(id);
    };
  }, [tips, id]);
}

export const fileRowId = (jobId: string, path: string) =>
  `file:${jobId}:${path}`;
export const filesRowId = (jobId: string) => `files:${jobId}`;

// The timeline whose clock the tracks are drawn on. It is the same from one
// pick to the next, so a track that reads it alone does not draw again for
// a pick: there are hundreds, of hundreds of marks each.
export const ClockContext = createContext<Timeline | null>(null);

// Where a time and a length sit on the whole clock, in percent.
function useClock() {
  const timeline = useContext(ClockContext);
  if (timeline === null) throw new Error("a timeline track outside a timeline");
  const length = Math.max(1, timeline.end - timeline.start);
  return {
    timeline,
    at: (time: number) => `${(100 * (time - timeline.start)) / length}%`,
    wide: (span: number) => `${(100 * Math.max(0, span)) / length}%`,
  };
}

// ---------------------------------------------------------------------------
// A row
// ---------------------------------------------------------------------------

function Pill({
  tone,
  title,
  children,
}: {
  tone: "failed" | "flaky" | "plain";
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={`tl-mk ${tone}`} title={title}>
      {children}
    </span>
  );
}

interface RowProps {
  id: string;
  // How far in the name sits; the first row, every job, is 0 and larger.
  depth: number;
  first?: boolean;
  // What kind of row it is, for its size.
  kind?: "job" | "file" | "test" | "note";
  quiet?: boolean;
  // Whether it opens, and is open; and whether a click does anything.
  opens?: boolean;
  open?: boolean;
  acts?: boolean;
  selected?: boolean;
  // Outside the pick while a job is open, and on the way down to it.
  rest?: boolean;
  way?: boolean;
  name: string;
  // A file's or a test's name, which may break after a part of it
  // (Breakable).
  code?: boolean;
  // What tells the row from another of its name, "attempt 2": a grey pill
  // after the name, which wraps with it.
  badge?: string;
  count?: string;
  marks?: ReactNode;
  track?: ReactNode;
  onActivate?: (_row: HTMLElement) => void;
}

function Row({
  id,
  depth,
  first = false,
  kind,
  quiet = false,
  opens = true,
  open = false,
  acts = true,
  selected = false,
  rest = false,
  way = false,
  name,
  code = false,
  badge,
  count,
  marks,
  track,
  onActivate,
}: RowProps) {
  const level = first ? 0 : Math.min(depth, 2) + 1;
  const press = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onActivate?.(event.currentTarget);
  };
  return (
    <div
      className={[
        "tl-row",
        `d${level}`,
        kind ?? "",
        quiet ? "quiet" : "",
        open ? "open" : "",
        selected ? "sel" : "",
        rest ? "rest" : "",
        way ? "way" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-row={id}
      {...(acts
        ? {
            role: "button",
            tabIndex: 0,
            "aria-expanded": opens ? open : undefined,
            onClick: (event) => onActivate?.(event.currentTarget),
            onKeyDown: press,
          }
        : {})}
    >
      <div className="tl-lbl" style={{ "--depth": depth } as object}>
        <ChevronRightIcon
          aria-hidden
          className={opens ? "cv" : "cv none"}
          fontSize="inherit"
        />
        <span className="nm">
          {code ? <Breakable text={name} /> : name}
          {badge !== undefined && (
            <>
              {" "}
              <Pill tone="plain">{badge}</Pill>
            </>
          )}
        </span>
        {count !== undefined && <span className="ct">{count}</span>}
        <span className="marks">{marks}</span>
      </div>
      <div className="tl-trk">
        <div className="tl-in">{track}</div>
      </div>
    </div>
  );
}

// How many of a row's jobs, or of a line's files, failed or were flaky.
function Tally({
  failed,
  flaky,
  unit,
}: {
  failed: number;
  flaky: number;
  unit: "job" | "file";
}) {
  return (
    <>
      {failed > 0 && (
        <Pill tone="failed" title={`${countLabel(failed, unit)} failed`}>
          {integerLabel(failed)} failed
        </Pill>
      )}
      {flaky > 0 && (
        <Pill
          tone="flaky"
          title={`${countLabel(flaky, unit)} with tests that passed on a rerun`}
        >
          {integerLabel(flaky)} flaky
        </Pill>
      )}
    </>
  );
}

// The line that stands for the rows folded away at a level while a job is
// open and, opened, those rows under it.
function OthersLine({
  others,
  depth,
  unit,
  children,
}: {
  others: OtherRows<unknown>;
  depth: number;
  // What the line's failed and flaky count.
  unit: "job" | "file";
  children: ReactNode;
}) {
  const { open, onActivate } = useRows();
  const isOpen = open.has(others.id);
  useTip(others.id, () =>
    plainTip(
      others.name,
      `Folded away while a ${unit} is open.`,
      isOpen ? "Click to fold them away." : "Click to list them."
    )
  );
  return (
    <>
      <Row
        id={others.id}
        depth={depth}
        kind="note"
        open={isOpen}
        rest
        name={others.name}
        marks={
          <Tally failed={others.failed} flaky={others.flaky} unit={unit} />
        }
        onActivate={(row) => onActivate({ kind: "others", id: others.id }, row)}
      />
      <Collapse in={isOpen} unmountOnExit timeout={280}>
        {children}
      </Collapse>
    </>
  );
}

// ---------------------------------------------------------------------------
// The rows above a job: every job, a workflow, a build
// ---------------------------------------------------------------------------

const RibbonTrack = memo(function RibbonTrack({ ribbon }: { ribbon: Ribbon }) {
  const { timeline } = useClock();
  const layers = useMemo(() => {
    const { tests, unaccounted, other } = ribbon;
    // While the jobs' tests are on their way a ribbon is its outline, in one
    // piece: two bands of one see-through grey show a line where they meet.
    if (timeline.testsPending) {
      return [
        {
          name: "whole",
          path: bandPath(
            () => 0,
            (slice) => tests[slice] + unaccounted[slice] + other[slice],
            ribbon
          ),
        },
      ];
    }
    return [
      {
        name: "tests",
        path: bandPath(
          () => 0,
          (slice) => tests[slice],
          ribbon
        ),
      },
      {
        name: "unaccounted",
        path: bandPath(
          (slice) => tests[slice],
          (slice) => tests[slice] + unaccounted[slice],
          ribbon
        ),
      },
      {
        name: "other",
        path: bandPath(
          (slice) => tests[slice] + unaccounted[slice],
          (slice) => tests[slice] + unaccounted[slice] + other[slice],
          ribbon
        ),
      },
    ];
  }, [ribbon, timeline.testsPending]);
  return (
    <>
      {layers.map(
        (layer) =>
          layer.path !== null && (
            <div
              key={layer.name}
              className={`tl-lay ${layer.name}`}
              style={{ clipPath: layer.path }}
            />
          )
      )}
    </>
  );
});

const JobTrack = memo(function JobTrack({
  job,
  cuts,
}: {
  job: TimelineJob;
  // Where the bar is cut: the ends of the open job's steps.
  cuts?: number[];
}) {
  const { at, wide, timeline } = useClock();
  if (job.kind === "skipped") {
    return <div className="tl-skip" style={{ left: at(job.created) }} />;
  }
  const waited = job.workStart - job.created;
  const { conclusion } = job.job;
  const cap = (conclusion === "failure" || conclusion === "cancelled") && (
    <div
      className={`tl-cap ${conclusion === "cancelled" ? "cancelled" : ""}`}
      style={{ left: `calc(${at(job.ended)} - 1px)` }}
    />
  );
  if (job.kind === "waiting") {
    return (
      <>
        <div
          className="tl-q"
          style={{ left: at(job.created), width: wide(waited) }}
        />
        {cap}
      </>
    );
  }
  // The line of dots runs until the job's container is up; the bar is the
  // job's own work, and the marks inside it are in percent of the bar.
  const extent = Math.max(1, job.ended - job.workStart);
  const inside = (time: number) =>
    `${(100 * (time - job.workStart)) / extent}%`;
  const share = (span: number) => `${(100 * span) / extent}%`;
  return (
    <>
      {waited >= 1 && (
        <div
          className="tl-q"
          style={{ left: at(job.created), width: wide(waited) }}
        />
      )}
      <div
        className="tl-b"
        style={{
          left: at(job.workStart),
          width: wide(job.ended - job.workStart),
        }}
      >
        {job.test !== null && !timeline.testsPending && (
          <i
            className="t"
            style={{
              left: inside(job.test.start),
              width: share(job.test.end - job.test.start),
            }}
          />
        )}
        {job.stretches.map((stretch) => (
          <i
            key={stretch.start}
            className="c"
            style={{
              left: inside(stretch.start),
              width: share(stretch.end - stretch.start),
            }}
          />
        ))}
        {cuts?.map((time) => (
          <i
            key={time}
            className="s"
            style={{ left: `calc(${inside(time)} - 1px)` }}
          />
        ))}
      </div>
      {cap}
    </>
  );
});

function nodeHint(node: TimelineNode, open: boolean, picked: boolean) {
  if (node.type === "small" || node.type === "bots") {
    return open ? "Click to fold them away." : "Click to list them.";
  }
  if (picked) return "Click to fold.";
  if (node.type === "job") return "Click for this job's steps and test files.";
  return "Click to open, and to list its tests below.";
}

// A row of the tree and, while it is open, the rows under it.
export function NodeRows({
  node,
  depth,
  first = false,
  rootHint,
}: {
  node: TimelineNode;
  depth: number;
  first?: boolean;
  // What a click on the first row does, for its tooltip.
  rootHint?: string;
}) {
  const { timeline, open, onPath, pickedId, focused, steps, onActivate } =
    useRows();
  const job = node.job;
  const isOpen =
    job !== undefined
      ? onPath.has(node.id) && job.kind !== "skipped"
      : open.has(node.id) || onPath.has(node.id);
  const selected = pickedId === node.id;
  // An open job's bar is its steps: cut where one ends and, while the job
  // is the pick, the pointer on it names the step it is on.
  const jobSteps = job !== undefined && isOpen ? steps : null;
  const cuts = useMemo(
    () =>
      job === undefined || jobSteps === null
        ? undefined
        : stepCuts(jobSteps, job),
    [job, jobSteps]
  );
  const hint = first ? rootHint : nodeHint(node, isOpen, selected);
  const ribbon = useMemo(
    () =>
      job === undefined
        ? ribbonOf(node.jobs, timeline.start, timeline.end)
        : null,
    [job, node, timeline]
  );
  useTip(node.id, (at) => {
    if (job !== undefined) {
      if (selected && at !== null && jobSteps !== null) {
        const index = stepAt(jobSteps, at);
        if (index >= 0) {
          return stepTip(jobSteps[index], index + 1, jobSteps.length);
        }
        if (at >= job.created && at < job.started) return waitTip(job);
      }
      return jobTip(job, hint, timeline.testsPending);
    }
    if (at === null || ribbon === null) {
      return node.type === "small"
        ? plainTip(
            node.name,
            `${countLabel(node.totals.ran, "job")} ran · ${hoursLabel(
              node.totals.run
            )} of running time`,
            hint
          )
        : nodeTip(node, hint, timeline.testsPending);
    }
    return ribbonTip(
      node,
      ribbon,
      timeline.start,
      at,
      hint,
      timeline.testsPending
    );
  });
  const { totals } = node;
  const marks =
    job !== undefined ? (
      job.bad !== null ? (
        <Pill tone={job.bad}>{job.bad}</Pill>
      ) : job.job.conclusion === "cancelled" ? (
        <Pill tone="plain">cancelled</Pill>
      ) : job.kind === "skipped" ? (
        <Pill tone="plain">skipped</Pill>
      ) : job.kind === "waiting" ? (
        <Pill tone="plain">waiting</Pill>
      ) : null
    ) : (
      <Tally failed={totals.failed} flaky={totals.flaky} unit="job" />
    );
  const under = first ? depth : depth + 1;
  // While a job is open, a row on the way to it lists the row that leads on
  // and a line for its others.
  const way =
    focused && isOpen && job === undefined ? rowsOnWay(node, onPath) : null;
  return (
    <>
      <Row
        id={node.id}
        depth={depth}
        first={first}
        kind={job !== undefined ? "job" : undefined}
        quiet={node.quiet}
        opens={job === undefined || job.kind !== "skipped"}
        open={isOpen}
        selected={selected}
        rest={focused && !selected}
        way={focused && !selected && onPath.has(node.id)}
        name={job === undefined ? node.name : nodeLabel(node)}
        badge={node.mark}
        count={job === undefined ? integerLabel(totals.ran) : undefined}
        marks={marks}
        track={
          job !== undefined ? (
            <JobTrack job={job} cuts={cuts} />
          ) : (
            ribbon !== null && <RibbonTrack ribbon={ribbon} />
          )
        }
        onActivate={(row) => onActivate({ kind: "node", node }, row)}
      />
      <Collapse in={isOpen} unmountOnExit timeout={280}>
        {job !== undefined ? (
          <JobInsides job={job} depth={under} />
        ) : (
          [
            ...(way === null ? rowsUnder(node) : [way.kept]).map((child) => (
              <NodeRows key={child.id} node={child} depth={under} />
            )),
            way !== null && way.others !== null && (
              <OthersLine
                key={way.others.id}
                others={way.others}
                depth={under}
                unit="job"
              >
                {way.others.rows.map((child) => (
                  <NodeRows key={child.id} node={child} depth={under + 1} />
                ))}
              </OthersLine>
            ),
          ]
        )}
      </Collapse>
    </>
  );
}

// ---------------------------------------------------------------------------
// Inside a job
// ---------------------------------------------------------------------------

// A job in one line, for where it is open: what happened, how long, and the
// way to GitHub.
function JobFacts({ job, depth }: { job: TimelineJob; depth: number }) {
  const { timeline } = useRows();
  const verdict = jobVerdict(job);
  const { failing } = job;
  const facts: ReactNode[] = [
    <span key="verdict" className={`verdict ${verdict.tone ?? ""}`}>
      {verdict.text}
    </span>,
  ];
  // A job no runner took has no running time and no steps.
  const ran = job.kind !== "waiting";
  if (ran) facts.push(`ran ${spanLabel(job.run)}`);
  if (job.queue >= 1) facts.push(`queued ${spanLabel(job.queue)}`);
  if (job.counts !== null) {
    facts.push(`${countLabel(countsTotal(job.counts), "test")} recorded`);
    if (failing > 0) {
      facts.push(
        <span key="failing" className="verdict failed">
          {countLabel(failing, "failing attempt")}
        </span>
      );
    }
  } else if (!timeline.testsPending) {
    // Said once the jobs' tests are in: until then none is known of any job.
    if (job.kind === "untested") facts.push("no test recorded");
    else if (ran) facts.push("no Test step");
  }
  if (job.job.url !== null) {
    facts.push(
      <TextLink key="github" href={job.job.url}>
        GitHub
        <OpenInNewIcon
          sx={{ fontSize: "0.9em", verticalAlign: "-0.15em", ml: 0.25 }}
        />
      </TextLink>
    );
  }
  return (
    <div className="tl-facts" style={{ "--depth": depth } as object}>
      {facts.flatMap((fact, index) =>
        index === 0
          ? [fact]
          : [
              <span key={`dot-${index}`} aria-hidden>
                ·
              </span>,
              fact,
            ]
      )}
    </div>
  );
}

const FileRuns = memo(function FileRuns({
  file,
  quiet,
}: {
  file: TimelineFile;
  quiet: boolean;
}) {
  const { at, wide } = useClock();
  return (
    <>
      {file.runs.map((run, index) => (
        <div
          key={index}
          className={`tl-run ${run.status}${quiet ? " quiet" : ""}`}
          style={{ left: at(run.start), width: wide(run.end - run.start) }}
        />
      ))}
    </>
  );
});

function TestRow({
  job,
  file,
  test,
  depth,
}: {
  job: TimelineJob;
  file: TimelineFile;
  test: TimelineTest;
  depth: number;
}) {
  const { pick, onActivate } = useRows();
  const { at, wide } = useClock();
  const selected =
    pick?.kind === "test" &&
    pick.jobId === job.job.id &&
    pick.file === file.path &&
    pick.suite === test.suite &&
    pick.caseName === test.name;
  const id = `test:${job.job.id}:${file.path}:${test.suite}:${test.name}`;
  // A test missing from the catalog has no name to be picked by.
  const named = test.run.test !== null;
  useTip(id, () =>
    testTip(
      test,
      !named
        ? undefined
        : selected
        ? "Click to step back."
        : "Click to list it below."
    )
  );
  const duration = test.attempts.reduce(
    (sum, attempt) =>
      attempt.tone === "skipped" ? sum : sum + attempt.end - attempt.start,
    0
  );
  const failed = test.status === "failed" || test.status === "timed_out";
  return (
    <Row
      id={id}
      depth={depth}
      kind="test"
      opens={false}
      acts={named}
      selected={selected}
      name={test.name}
      code
      count={durationLabel(duration * 1000)}
      marks={
        failed ? (
          <Pill tone="failed">
            {test.status === "failed" ? "failed" : "timed out"}
          </Pill>
        ) : test.status === "flaky" ? (
          <Pill tone="flaky">flaky</Pill>
        ) : null
      }
      track={test.attempts.map((attempt, index) => (
        <div
          key={index}
          className={`tl-at ${attempt.tone}`}
          style={{
            left: at(attempt.start),
            width: wide(attempt.end - attempt.start),
          }}
        />
      ))}
      onActivate={(row) => onActivate({ kind: "test", job, file, test }, row)}
    />
  );
}

// Rows that hold a place while what goes there is on its way.
function LoadingRows({ depth, rows }: { depth: number; rows: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_unused, index) => (
        <div key={index} className="tl-row note" aria-hidden>
          <div className="tl-lbl" style={{ "--depth": depth } as object}>
            <Skeleton
              variant="text"
              sx={{ width: `${60 - index * 12}%`, ml: "22px" }}
            />
          </div>
          <div className="tl-trk">
            <Skeleton variant="rounded" height={8} sx={{ width: "100%" }} />
          </div>
        </div>
      ))}
    </>
  );
}

function FileRows({
  job,
  file,
  depth,
  rest = false,
}: {
  job: TimelineJob;
  file: TimelineFile;
  depth: number;
  rest?: boolean;
}) {
  const { repo, sha, pick, onActivate } = useRows();
  const inFile =
    (pick?.kind === "file" || pick?.kind === "test") &&
    pick.jobId === job.job.id &&
    pick.file === file.path;
  const selected = inFile && pick?.kind === "file";
  const id = fileRowId(job.job.id, file.path);
  // Tests missing from the catalog have no file to be picked by.
  const named = file.path !== "";
  useTip(id, () =>
    fileTip(
      file,
      !named
        ? undefined
        : selected
        ? "Click to fold."
        : "Click for this file's tests, here and below."
    )
  );
  // The file's tests are asked for when it is opened.
  const { data, error, retry } = useFileTests(
    repo,
    sha,
    inFile ? job.job.id : null,
    inFile ? file.path : null
  );
  const tests = useMemo(
    () => data?.runs.slice(0, LISTED_TESTS).map(timelineTest),
    [data]
  );
  const more = tests === undefined ? 0 : file.tests - tests.length;
  const moreId = `more:${job.job.id}:${file.path}`;
  useTip(moreId, () =>
    plainTip(
      `${countLabel(more, "more test")}`,
      "The table below lists every test of the file."
    )
  );
  return (
    <>
      <Row
        id={id}
        depth={depth}
        kind="file"
        opens={named}
        acts={named}
        open={inFile}
        selected={selected}
        rest={rest}
        name={file.name}
        code
        count={integerLabel(file.tests)}
        marks={
          file.status === "failed" ? (
            <Pill tone="failed">failed</Pill>
          ) : file.status === "flaky" ? (
            <Pill tone="flaky">flaky</Pill>
          ) : null
        }
        track={<FileRuns file={file} quiet={false} />}
        onActivate={(row) => onActivate({ kind: "file", job, file }, row)}
      />
      <Collapse in={inFile} unmountOnExit timeout={280}>
        {error !== undefined ? (
          <div className="tl-facts" style={{ "--depth": depth + 1 } as object}>
            <LoadError what="the file's tests" error={error} onRetry={retry} />
          </div>
        ) : tests === undefined ? (
          <LoadingRows depth={depth + 1} rows={3} />
        ) : (
          <>
            {tests.map((test) => (
              <TestRow
                key={`${test.suite}:${test.name}:${test.run.attempts[0]?.id}`}
                job={job}
                file={file}
                test={test}
                depth={depth + 1}
              />
            ))}
            {more > 0 && (
              <Row
                id={moreId}
                depth={depth + 1}
                kind="note"
                opens={false}
                acts={false}
                name={countLabel(more, "more test")}
              />
            )}
          </>
        )}
      </Collapse>
    </>
  );
}

// A job's shorter files under one row. While one of them is open it alone is
// listed, with a line for the others.
function ShorterFiles({
  job,
  files,
  depth,
  rest,
}: {
  job: TimelineJob;
  files: TimelineFile[];
  depth: number;
  rest: boolean;
}) {
  const { open, pick, focused, onActivate } = useRows();
  const id = filesRowId(job.job.id);
  const openPath =
    (pick?.kind === "file" || pick?.kind === "test") &&
    pick.jobId === job.job.id &&
    files.some((file) => file.path === pick.file)
      ? pick.file
      : null;
  const isOpen = open.has(id) || openPath !== null;
  useTip(id, () =>
    plainTip(
      `${countLabel(files.length, "shorter file")}`,
      `${countLabel(
        files.reduce((sum, file) => sum + file.tests, 0),
        "test"
      )} · ${spanLabel(
        files.reduce((sum, file) => sum + file.duration, 0)
      )} in all, each under 3% of this job's test time`,
      isOpen ? "Click to fold them away." : "Click to list them."
    )
  );
  const onWay = focused && openPath !== null;
  const others = onWay
    ? otherFiles(
        id,
        files.filter((file) => file.path !== openPath)
      )
    : null;
  return (
    <>
      <Row
        id={id}
        depth={depth}
        kind="file"
        open={isOpen}
        rest={rest}
        way={onWay}
        name={countLabel(files.length, "shorter file")}
        track={files.map((file) => (
          <FileRuns key={file.path} file={file} quiet />
        ))}
        onActivate={(row) => onActivate({ kind: "files", job, files }, row)}
      />
      <Collapse in={isOpen} unmountOnExit timeout={280}>
        {[
          ...(onWay
            ? files.filter((file) => file.path === openPath)
            : files
          ).map((file) => (
            <FileRows
              key={file.path}
              job={job}
              file={file}
              depth={depth + 1}
              rest={rest && !onWay}
            />
          )),
          others !== null && (
            <OthersLine
              key={others.id}
              others={others}
              depth={depth + 1}
              unit="file"
            >
              {others.rows.map((file) => (
                <FileRows
                  key={file.path}
                  job={job}
                  file={file}
                  depth={depth + 2}
                  rest
                />
              ))}
            </OthersLine>
          ),
        ]}
      </Collapse>
    </>
  );
}

function JobInsides({ job, depth }: { job: TimelineJob; depth: number }) {
  const { pick, focused, timeline } = useRows();
  const { data, error, retry } = useJobDetail(job.job.id);
  const files = useMemo(
    () => (data === undefined ? undefined : namedFiles(timelineFiles(data))),
    [data]
  );
  const named = files?.named ?? [];
  const shorter = files?.rest ?? [];
  // While a file is open it alone is listed, or the row of shorter files
  // that holds it, with a line for the job's other files.
  const openPath =
    (pick?.kind === "file" || pick?.kind === "test") &&
    pick.jobId === job.job.id
      ? pick.file
      : null;
  const openNamed = named.find((file) => file.path === openPath);
  const openShorter = shorter.some((file) => file.path === openPath);
  const onWay = focused && (openNamed !== undefined || openShorter);
  const otherNamed = onWay ? named.filter((file) => file !== openNamed) : [];
  const others = onWay
    ? otherFiles(jobNodeId(job.job.id), [
        ...otherNamed,
        ...(openShorter ? [] : shorter),
      ])
    : null;
  return (
    <>
      <JobFacts job={job} depth={depth} />
      {error !== undefined ? (
        <div className="tl-facts" style={{ "--depth": depth } as object}>
          <LoadError what="the job" error={error} onRetry={retry} />
        </div>
      ) : data === undefined || files === undefined ? (
        // Only a job that recorded tests has rows to come: its files. While
        // the jobs' tests are on their way, a job with a Test step may.
        (job.kind === "tests" ||
          (timeline.testsPending && job.test !== null)) && (
          <LoadingRows depth={depth} rows={3} />
        )
      ) : (
        <>
          {(onWay ? named.filter((file) => file === openNamed) : named).map(
            (file) => (
              <FileRows key={file.path} job={job} file={file} depth={depth} />
            )
          )}
          {shorter.length > 0 && (!onWay || openShorter) && (
            <ShorterFiles
              job={job}
              files={shorter}
              depth={depth}
              rest={onWay}
            />
          )}
          {others !== null && (
            <OthersLine others={others} depth={depth} unit="file">
              {otherNamed.map((file) => (
                <FileRows
                  key={file.path}
                  job={job}
                  file={file}
                  depth={depth + 1}
                  rest
                />
              ))}
              {!openShorter && shorter.length > 0 && (
                <ShorterFiles
                  job={job}
                  files={shorter}
                  depth={depth + 1}
                  rest
                />
              )}
            </OthersLine>
          )}
        </>
      )}
    </>
  );
}
