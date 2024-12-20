import { basicSetup } from "@codemirror/basic-setup";
import { codeFolding, foldAll, foldService } from "@codemirror/language";
import { search } from "@codemirror/search";
import {
  EditorSelection,
  EditorState,
  Range,
  RangeSet,
} from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { parse } from "ansicolor";
import { isFailure } from "lib/JobClassifierUtil";
import { LogSearchResult } from "lib/searchLogs";
import { JobData, LogAnnotation } from "lib/types";
import { Dispatch, SetStateAction, useEffect, useRef, useState } from "react";
import useSWRImmutable from "swr";
import LogAnnotationToggle from "./LogAnnotationToggle";

const ESC_CHAR_REGEX = /\x1b\[[0-9;]*m/g;
// Based on the current editor view, produce a series of decorations that
// correctly colorize the ANSI escape codes found in the view.
function computeDecorations(view: EditorView) {
  let builder: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const lineText = line.text;
      // If we detect an escape code in this line
      if (lineText.includes("\x1b[")) {
        // Build highlight colors for this line.
        const parsed = parse(lineText);

        // Cursor for tracking our position while processing the line.
        let cursor = 0;

        // @ts-expect-error
        // Iterate through each segment of the line that has a color.
        for (const segment of parsed) {
          // Find the start position of this segment within the line, starting
          // at the cursor.
          const startWithinLine = lineText.indexOf(segment.text, cursor);

          // Translate that position to an absolute position within the document.
          const decoFrom = pos + startWithinLine;
          const decoTo = decoFrom + segment.text.length;

          // Add a decoration based on the computed style.
          if (segment.css === "color:rgba(0,0,0,0.5);") {
            // LogViewer has a dark background, so rewrite black to be...not black.
            segment.css = "color:rgba(171,178,191,0.75);";
          }
          builder.push(
            Decoration.mark({ attributes: { style: segment.css } }).range(
              decoFrom,
              decoTo
            )
          );

          // Update our cursor within the line.
          cursor = startWithinLine + segment.text.length;
        }

        // Also hide all the weird escape characters.
        for (const match of lineText.matchAll(ESC_CHAR_REGEX)) {
          const startWithinLine = match.index;
          const decoFrom = pos + startWithinLine!;
          const decoTo = decoFrom + match[0].length;

          builder.push(
            Decoration.replace({ inclusiveStart: true }).range(decoFrom, decoTo)
          );
        }
      }

      // Update our position within the viewport.
      pos = line.to + 1;
    }
  }
  return RangeSet.of(builder, /*sort=*/ true);
}

// Fold the uninteresting parts of the log.
// - Anything in a GitHub group (e.g. gets automatically collapse in GitHub UI)
// - All the "cleanup" stuff (e.g. anything after the actual build/test). This
//   part is hardcoded but should be good enough for starters.
const foldUninteresting = foldService.of(
  (state: EditorState, lineStart: number, lineEnd: number) => {
    const startingLine = state.doc.lineAt(lineStart);
    if (!startingLine.text.includes("##[group]")) {
      return null;
    }

    // If this group begins the teardown process, just fold the entire rest of
    // the document.
    if (
      startingLine.text.includes(".github/actions/teardown") ||
      startingLine.text.includes("Post job cleanup.")
    ) {
      return { from: lineStart, to: state.doc.length };
    }

    // Otherwise find the ##[endgroup] line.
    for (let pos = lineEnd + 1; pos < state.doc.length; ) {
      const line = state.doc.lineAt(pos);
      if (line.text.includes("##[endgroup]")) {
        return { from: lineStart, to: line.to };
      }
      pos = line.to + 1;
    }

    return null;
  }
);

// View plugin for displaying ANSI colors in the log viewer correctly.
// The real logic is in computeDecorations()
const ansiColors = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = computeDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged)
        this.decorations = computeDecorations(update.view);
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

const fetcher = (url: string) => fetch(url).then((res) => res.text());

function JumpToLineButton({
  lineText,
  line,
  setCurrentLine,
  currentLine,
}: {
  setCurrentLine: Dispatch<SetStateAction<number | undefined>>;
  lineText: string | undefined;
  line: number | undefined;
  currentLine: number | undefined;
}) {
  // This is the component that shows the failed line (or really whatever line
  // you want it to show), and clicking it opens the log viewer and jumps to
  // that line
  const isCurrentLine = currentLine == line;

  function setCurrentLineHelper() {
    if (isCurrentLine) {
      // Toggle off the log viewer
      setCurrentLine(undefined);
    } else {
      setCurrentLine(line);
    }
  }

  return (
    <div>
      <button
        style={{ background: "none", cursor: "pointer", textAlign: "left" }}
        onClick={setCurrentLineHelper}
      >
        <div>
          {isCurrentLine ? "▼ " : "▶ "}
          <code onDoubleClick={(e) => e.stopPropagation()}>
            {lineText ?? "Show log"}
          </code>
        </div>
      </button>
    </div>
  );
}

function scrollToLine(state: EditorState, view: EditorView, line: number) {
  if (line != 0 && state.doc.length > line) {
    // Select and center the failure line
    const focusLine = state.doc.line(line);
    view.dispatch({
      selection: EditorSelection.cursor(focusLine.from),
      effects: EditorView.scrollIntoView(focusLine.from, { y: "center" }),
    });
  } else {
    // If we don't have a failure line, just scroll to the bottom.
    view.dispatch({
      effects: EditorView.scrollIntoView(
        state.doc.line(state.doc.lines).from,
        {}
      ),
    });
  }
}

function Log({
  url,
  currentLine,
}: {
  url: string;
  currentLine: number | undefined;
}) {
  // Only download the log and generate the log viewer if the log is open.  This
  // is only used in one component but needs to be separate due to hooks rules,
  // as useSWR cannot be called behind an if statement.

  const { data } = useSWRImmutable(url, fetcher);
  const state = EditorState.create({
    doc: data ?? "Loading...",
    extensions: [
      basicSetup, // standard text editor things
      EditorState.readOnly.of(true), // make the editor read-only
      EditorView.theme({ "&": { height: "90vh" } }), // set height
      EditorView.theme({ ".cm-activeLine": { backgroundColor: "indigo" } }), // set height
      oneDark, // set theme
      ansiColors, // properly render ansi colors in the logs
      foldUninteresting, // Fold the uninteresting parts of the log to clean up the view.
      codeFolding({
        placeholderText: "<probably uninteresting folded group, click to show>",
      }),
      search({ top: true }),
    ],
  });

  const viewer = useRef<HTMLDivElement>(null!);
  useEffect(() => {
    if (state.doc) {
      const view = new EditorView({ state, parent: viewer.current });
      foldAll(view);
      // I wish I could pull this out into a different useEffect, but I couldn't
      // figure out how to get the view to update
      scrollToLine(state, view, currentLine ?? 0);
      return () => {
        view.destroy();
      };
    }
  }, [state, currentLine, data]);

  return <div ref={viewer} onDoubleClick={(e) => e.stopPropagation()}></div>;
}

function LogWithLineSelector({
  url,
  lineNumbers,
  lineTexts,
}: {
  url: string;
  lineNumbers: number[];
  lineTexts: string[];
}) {
  // The base log viewer with a line selector.  To open the log viewer, select
  // any of the lines.  If another line is selected, the log viewer will jump to
  // that line.  To close it, select currently open line.

  useEffect(() => {
    document.addEventListener("copy", (e) => {
      const selection = document.getSelection();
      e.clipboardData?.setData(
        "text/plain",
        (selection?.toString() ?? "").replaceAll(ESC_CHAR_REGEX, "")
      );
      e.preventDefault();
    });
  });
  // undefined means that no line is selected, so the log viewer is closed
  const [currentLine, setCurrentLine] = useState<number | undefined>(undefined);
  // TODO: Remove this. This is a hack to make sure that that the log viewer
  // will always show up. It gets around some differences in output between
  // rockset and clickhouse
  if (lineNumbers.length === 0) {
    lineNumbers = [0];
  }
  return (
    <>
      {lineNumbers.map((line, index) => (
        <JumpToLineButton
          lineText={lineTexts[index]}
          line={line}
          setCurrentLine={setCurrentLine}
          currentLine={currentLine}
          key={`line-${line}`}
        />
      ))}
      {currentLine !== undefined && <Log url={url} currentLine={currentLine} />}
    </>
  );
}

export default function LogViewer({
  job,
  logRating = LogAnnotation.NULL,
  showAnnotationToggle = process.env.DEBUG_LOG_CLASSIFIER === "true",
}: {
  job: JobData;
  logRating?: LogAnnotation;
  showAnnotationToggle?: boolean;
}) {
  if (!job.failureLines && !isFailure(job.conclusion)) {
    return null;
  }

  return (
    <div>
      <LogWithLineSelector
        url={job.logUrl!}
        lineNumbers={job.failureLineNumbers?.map((x) => (x ? x : 0)) ?? []} // Convert undefined/null to 0
        lineTexts={job.failureLines ?? []}
      />
      {showAnnotationToggle && (
        <div>
          <LogAnnotationToggle
            job={job}
            // send in real metadata later
            log_metadata={{ job_id: "1" }}
            annotation={logRating}
          />
        </div>
      )}
    </div>
  );
}

export function SearchLogViewer({
  url,
  logSearchResult,
}: {
  url: string;
  logSearchResult: LogSearchResult | undefined;
}) {
  // This is the search equivalent of LogViewer.  It is almost the same thing
  // but also displays info about how many matches there were for the search

  let lineNumbers = logSearchResult?.results.map((v) => v.lineNumber) ?? [];
  let lineTexts = logSearchResult?.results.map((v) => v.lineText) ?? [];

  return (
    <>
      <div>
        <small>
          &nbsp;&nbsp;&nbsp;&nbsp;{logSearchResult?.info ?? "Loading..."}
        </small>
      </div>
      <LogWithLineSelector
        url={url}
        lineNumbers={lineNumbers}
        lineTexts={lineTexts}
      />
    </>
  );
}
