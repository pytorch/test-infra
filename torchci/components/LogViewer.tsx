import { basicSetup } from "@codemirror/basic-setup";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  EditorView,
  ViewUpdate,
  ViewPlugin,
  DecorationSet,
  Decoration,
} from "@codemirror/view";
import { RangeSet, Range } from "@codemirror/state";
import { foldService, codeFolding, foldAll } from "@codemirror/language";
import { parse } from "ansicolor";

import { JobData } from "lib/types";
import { useEffect, useRef, useState } from "react";
import useSWRImmutable from "swr";
import { oneDark } from "@codemirror/theme-one-dark";
import _ from "lodash";
import { isFailure } from "lib/JobClassifierUtil";

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
        for (const match of lineText.matchAll(/\x1b\[[0-9;]*m/g)) {
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
      startingLine.text.includes("github/actions/get-workflow-job-id") ||
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
function Log({ url, line }: { url: string; line: number | null }) {
  const { data } = useSWRImmutable(url, fetcher);
  const viewer = useRef<HTMLDivElement>(null!);

  useEffect(() => {
    const state = EditorState.create({
      doc: data ?? "loading...",
      extensions: [
        basicSetup, // standard text editor things
        EditorState.readOnly.of(true), // make the editor read-only
        EditorView.theme({ "&": { height: "90vh" } }), // set height
        EditorView.theme({ ".cm-activeLine": { backgroundColor: "indigo" } }), // set height
        oneDark, // set theme
        ansiColors, // properly render ansi colors in the logs
        foldUninteresting, // Fold the uninteresting parts of the log to clean up the view.
        codeFolding({
          placeholderText:
            "<probably uninteresting folded group, click to show>",
        }),
      ],
    });

    const view = new EditorView({ state, parent: viewer.current });

    foldAll(view);
    if (data !== undefined) {
      if (line != null) {
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
    return () => {
      view.destroy();
    };
  }, [data, line]);

  return <div ref={viewer}></div>;
}

export default function LogViewer({ job }: { job: JobData }) {
  const [showLogViewer, setShowLogViewer] = useState(false);
  if (!isFailure(job.conclusion)) {
    return null;
  }

  function handleClick() {
    setShowLogViewer(!showLogViewer);
  }

  return (
    <div>
      <div style={{ cursor: "pointer" }} onClick={handleClick}>
        {showLogViewer ? "▼ " : "▶ "}
        <code>{job.failureLine ?? "Show log"}</code>
      </div>
      {showLogViewer && <Log url={job.logUrl!} line={job.failureLineNumber!} />}
    </div>
  );
}
