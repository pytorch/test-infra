import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Divider, Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWRImmutable from "swr/immutable";
import { LogUrlList } from "./BenchmarkLogList";
import { MultiLogViewer } from "./MultiLogViewer";
import { filterByTerms, tokenizeQuery } from "./utils";

const fetchText = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  return r.text();
};

export type LogSrc = {
  url: string;
  label?: string;
  info?: Record<string, string[]>;
};

function lineCount(txt: string): number {
  // count of lines in CodeMirror is 1 + number of '\n'
  // but we need the number of *line breaks*, so using split keeps it simple
  return txt.length ? txt.split("\n").length : 1;
}

/** Compute combined doc + per-file starting line offsets (for scrolling). */
function combineLogs(texts: string[], labels: string[]) {
  const sep = (label: string) =>
    `\n────────────────────────────────────────────────────────\n` +
    ` ${label}\n` +
    `────────────────────────────────────────────────────────\n`;

  const offsets: number[] = []; // starting line (1-based) of each file in the combined doc
  let currentLine = 1;
  const parts: string[] = [];

  texts.forEach((t, i) => {
    const header = sep(labels[i] ?? `Log ${i + 1}`);
    const block = `${i > 0 ? "\n" : ""}${header}${t}`;
    offsets.push(currentLine + lineCount(header) - 1);
    parts.push(block);
    currentLine += lineCount(block);
  });

  return { combined: parts.join(""), offsets };
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

export function BenchmarkLogViewContent({
  urls,
  current,
  editorWidth = "70vw",
  listWidth = "25%",
}: {
  urls: LogSrc[];
  /** optional: scroll target like {fileIndex: 0, line: 42} (1-based line in that file) */
  current?: { fileIndex: number; line: number };
  editorWidth?: string | number;
  listWidth?: string | number;
}) {
  // shared query (plain string; chip UI can sit outside or inside LogUrlList)
  const [query, setQuery] = useState("");

  // 1) tokenize + filter first (shared utils)
  const terms = useMemo(() => tokenizeQuery(query), [query]);
  const filteredUrls = useMemo(() => filterByTerms(urls, terms), [urls, terms]);

  // fetch only filtered URLs
  const keys = useMemo(() => filteredUrls.map((u) => u.url), [filteredUrls]);
  const swrKey = keys.length ? (["logs", ...keys] as const) : null;
  const { data: texts, error } = useSWRImmutable(
    swrKey,
    async (key: readonly [string, ...string[]]) => {
      const [, ...list] = key;
      return Promise.all(list.map(fetchText));
    }
  );

  // labels for filtered (stable)
  const labels = useMemo(
    () => filteredUrls.map((u, i) => u.label ?? u.url ?? `Log ${i + 1}`),
    [filteredUrls]
  );

  // combine fetched subset
  const combined = useMemo(() => {
    if (!texts) return { combined: "Loading...", offsets: [1] as number[] };
    return combineLogs(texts, labels);
  }, [texts, labels]);

  const viewRef = useRef<EditorView | null>(null);

  // scroll to target line when ready (after texts/combined are ready)
  useEffect(() => {
    const v = viewRef.current;
    if (!v || !texts) return;

    if (
      current &&
      current.fileIndex >= 0 &&
      current.fileIndex < combined.offsets.length
    ) {
      const globalLine =
        combined.offsets[current.fileIndex] + (current.line - 1);
      scrollToLine(v.state, v, globalLine);
    } else {
      // optional: fold all on re-compute
      // foldAll(v);
    }
  }, [texts, current?.fileIndex, current?.line, combined.offsets]);

  if (error) {
    return (
      <Box sx={{ color: "tomato" }}>Failed to load logs: {String(error)}</Box>
    );
  }

  return (
    <Stack direction="row" spacing={1}>
      {/* search + list uses the same query that drives filtering/fetching */}
      <LogUrlList
        urls={urls}
        viewRef={viewRef}
        query={query}
        setQuery={setQuery}
        width={listWidth}
      />
      <Divider sx={{ mt: 2 }} />
      <Box sx={{ width: editorWidth, minWidth: "500px", height: "90vh" }}>
        <Typography variant="h6" sx={{ mb: 1 }}>
          Combined Loggings (
          {`# Display ${filteredUrls.length}/${urls.length} logs`})
        </Typography>
        <MultiLogViewer
          viewRef={viewRef}
          doc={combined.combined}
          width="100%"
          height="90vh"
          // extraExtensions={[/* add more if needed */]}
          autoFoldOnMount
        />
      </Box>
    </Stack>
  );
}
