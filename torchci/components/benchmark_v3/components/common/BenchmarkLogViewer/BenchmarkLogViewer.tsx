import { basicSetup } from "@codemirror/basic-setup";
import { codeFolding, foldAll } from "@codemirror/language";
import { search } from "@codemirror/search";
import { EditorSelection, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import {
  Divider,
  Typography,
} from "@mui/material";
import { Box, Stack } from "@mui/system";
import { foldUninteresting } from "components/common/log/LogViewer";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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


// --- helper: simple filter across label/url/info
function filterUrls(urls: LogSrc[], query: string): LogSrc[] {
  const q = query.trim().toLowerCase();
  if (!q) return urls;
  return urls.filter((u) => {
    const infoStr = u.info
      ? Object.entries(u.info)
          .map(([k, v]) =>
            Array.isArray(v) ? `${k}:${v.join(",")}` : `${k}:${String(v)}`
          )
          .join(" ")
          .toLowerCase()
      : "";
    return (
      (u.label ?? "").toLowerCase().includes(q) ||
      u.url.toLowerCase().includes(q) ||
      infoStr.includes(q)
    );
  });
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function highlightChunks(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const pat = new RegExp(escapeRegExp(query), "ig");
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pat.exec(text)) !== null) {
    const start = m.index,
      end = start + m[0].length;
    if (start > last) out.push(text.slice(last, start));
    out.push(<mark key={`${start}-${end}`}>{text.slice(start, end)}</mark>);
    last = end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function BenchmarkLogViewer({
  urls,
  current,
  height = "100%",
}: {
  urls: LogSrc[];
  current?: { fileIndex: number; line: number };
  height?: string | number;
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
          "&": { height: typeof height === "number" ? `${height}px` : height },
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
  }, [combined.combined, height]);

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
    <Box>
      {/* search + list uses the same query that drives filtering/fetching */}
      <LogUrlList
        urls={filteredUrls}
        viewRef={viewRef}
        query={query}
        setQuery={setQuery}
      />
      <Divider sx={{ mt: 2 }} />
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          {`# Combined ${filteredUrls.length}/${urls.length} logs`}
        </Typography>
        <div ref={viewerRef} onDoubleClick={(e) => e.stopPropagation()} />
      </Box>
    </Box>
  );
}
