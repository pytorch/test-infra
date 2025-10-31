import { basicSetup } from "@codemirror/basic-setup";
import { codeFolding, foldAll } from "@codemirror/language";
import { search } from "@codemirror/search";
import { EditorSelection, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { Divider, Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";
import { foldUninteresting } from "components/common/log/LogViewer";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWRImmutable from "swr/immutable";
import { LogUrlList } from "./BenchmarkLogList";

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

export function BenchmarkLogViewer({
  urls,
  current,
  editorWidth = "70vw",
  listWidth = "25%",
}: {
  urls: LogSrc[];
  current?: { fileIndex: number; line: number };
  editorWidth?: string | number;
  listWidth?: string | number;
}) {
  // shared query
  const [query, setQuery] = useState("");

  // 1) filter first
  const filteredUrls = useMemo(() => filterUrls(urls, query), [urls, query]);

  // 2) keys only from filtered
  const keys = useMemo(() => filteredUrls.map((u) => u.url), [filteredUrls]);

  // 3) fetch only filtered URLs (parallel)
  const swrKey = keys.length ? (["logs", ...keys] as const) : null;
  const { data: texts, error } = useSWRImmutable(
    swrKey,
    async (key: readonly [string, ...string[]]) => {
      const [, ...list] = key;
      return Promise.all(list.map(fetchText));
    }
  );

  // 4) labels from filtered
  const labels = useMemo(
    () => filteredUrls.map((u, i) => u.label ?? u.url ?? `Log ${i + 1}`),
    [filteredUrls]
  );

  // 5) combine fetched subset
  const combined = useMemo(() => {
    if (!texts) return { combined: "Loading...", offsets: [1] };
    return combineLogs(texts, labels);
  }, [texts, labels]);

  // 6) CodeMirror view
  const viewerRef = useRef<HTMLDivElement>(null!);
  const viewRef = useRef<EditorView | null>(null);

  // Build editor state whenever combined/height changes
  const state = useMemo(() => {
    return EditorState.create({
      doc: combined.combined,
      extensions: [
        basicSetup,
        EditorState.readOnly.of(true),
        EditorView.theme({
          "&": { width: "100%", height: "90vh", boxSizing: "border-box" },
        }),
        EditorView.theme({ ".cm-activeLine": { backgroundColor: "indigo" } }),
        oneDark,
        // your folding extensions:
        foldUninteresting,
        codeFolding({
          placeholderText:
            "<probably uninteresting folded group, click to show>",
        }),
        search({ top: true }),
      ],
    });
  }, [combined.combined, editorWidth]);

  useEffect(() => {
    if (!viewerRef.current) return;
    if (!viewRef.current) {
      const v = new EditorView({ state, parent: viewerRef.current });
      viewRef.current = v;
      foldAll(v);
    } else {
      viewRef.current.setState(state);
    }

    const v = viewRef.current!;
    if (
      texts &&
      current &&
      current.fileIndex >= 0 &&
      current.fileIndex < combined.offsets.length
    ) {
      const globalLine =
        combined.offsets[current.fileIndex] + (current.line - 1);
      scrollToLine(v.state, v, globalLine);
    } else if (texts) {
      foldAll(v);
    }
  }, [state, texts, current?.fileIndex, current?.line, combined.offsets]);

  useEffect(() => {
    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, []);

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
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          {`# Combined ${filteredUrls.length}/${urls.length} logs`}
        </Typography>
        <div ref={viewerRef} onDoubleClick={(e) => e.stopPropagation()} />
      </Box>
    </Stack>
  );
}

function parseTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .split(/\s+/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

export function filterUrls(urls: LogSrc[], query: string): LogSrc[] {
  const terms = parseTerms(query);
  if (terms.length === 0) return urls;
  return urls.filter((u) => {
    const hay = buildHaystack(u);
    return terms.every((t) => hay.includes(t)); // AND logic, case-insensitive
  });
}

function buildHaystack(u: LogSrc): string {
  const parts = [u.label ?? "", u.url ?? "", ...flattenInfo(u.info ?? {})];
  return parts.join(" ").toLowerCase();
}

function flattenInfo(val: unknown, out: string[] = []): string[] {
  if (val == null) return out;
  if (
    typeof val === "string" ||
    typeof val === "number" ||
    typeof val === "boolean"
  ) {
    out.push(String(val));
  } else if (Array.isArray(val)) {
    for (const v of val) flattenInfo(v, out);
  } else if (typeof val === "object") {
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out.push(k); // include keys so "arch", "device" are searchable
      flattenInfo(v, out); // include values (nested ok)
    }
  }
  return out;
}
