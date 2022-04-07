import { basicSetup } from "@codemirror/basic-setup";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { JobData } from "lib/types";
import { useEffect, useRef, useState } from "react";
import useSWRImmutable from "swr";
import { oneDark } from "@codemirror/theme-one-dark";
import _ from "lodash";

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
