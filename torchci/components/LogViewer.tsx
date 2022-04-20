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
import { parse } from "ansicolor";

import { JobData } from "lib/types";
import { useEffect, useRef, useState } from "react";
import useSWRImmutable from "swr";
import { oneDark } from "@codemirror/theme-one-dark";
import _ from "lodash";

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
function Log({ url, line }: { url: string; line: number }) {
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
        ansiColors,
      ],
    });

    const view = new EditorView({ state, parent: viewer.current });
    if (data !== undefined) {
      const focusLine = state.doc.line(line);
      view.dispatch({
        selection: EditorSelection.cursor(focusLine.from),
        effects: EditorView.scrollIntoView(focusLine.from, { y: "center" }),
      });
    }
    return () => {
      view.destroy();
    };
  }, [data, line]);

  return <div ref={viewer}></div>;
}

export default function LogViewer({ job }: { job: JobData }) {
  const [showLogViewer, setShowLogViewer] = useState(false);
  if (job.failureLine == null) {
    return null;
  }

  function handleClick() {
    setShowLogViewer(!showLogViewer);
  }

  return (
    <div>
      {showLogViewer ? "▼ " : "▶ "}
      <code style={{ cursor: "pointer" }} onClick={handleClick}>
        {job.failureLine}
      </code>
      {showLogViewer && <Log url={job.logUrl!} line={job.failureLineNumber!} />}
    </div>
  );
}
