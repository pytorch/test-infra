import { basicSetup } from "@codemirror/basic-setup";
import { codeFolding, foldAll } from "@codemirror/language";
import { search } from "@codemirror/search";
import { EditorSelection, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import CloseIcon from "@mui/icons-material/Close";
import {
  Button,
  Divider,
  Drawer,
  IconButton,
  Link,
  Typography,
} from "@mui/material";
import { Box } from "@mui/system";
import { foldUninteresting } from "components/common/log/LogViewer";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWRImmutable from "swr/immutable";

const fetchText = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  return r.text();
};

export type LogSrc = { url: string; label?: string };

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

export function BenchmarkLogSidePanelWrapper({
  urls,
  current,
  height = "90vh",
  buttonLabel = "Show logs",
  panelTitle = "Benchmark Logs",
  widthPx = "50vw",
}: {
  urls: LogSrc[];
  current?: { fileIndex: number; line: number };
  height?: string | number;
  buttonLabel?: string;
  panelTitle?: string;
  widthPx?: any;
}) {
  const [open, setOpen] = useState(false);
  const handleOpen = () => setOpen(true);
  const handleClose = () => setOpen(false);

  return (
    <Box>
      <Button variant="outlined" size="small" onClick={handleOpen}>
        {buttonLabel}
      </Button>
      <Drawer
        anchor="right"
        open={open}
        onClose={handleClose}
        slotProps={{
          paper: {
            sx: {
              width: widthPx,
              maxWidth: "90vw",
            },
          },
        }}
      >
        {/* Header */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            px: 2,
            py: 1,
            borderBottom: "1px solid",
            borderColor: "divider",
          }}
        >
          <Typography variant="subtitle1">{panelTitle}</Typography>
          <IconButton size="small" onClick={handleClose}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
        <Divider />
        <Box sx={{ mx: 1 }}>
          <LogUrlList urls={urls} />
        </Box>
        {/* Lazy-render the log viewer only when open */}
        {open && (
          <Box sx={{ flex: 1, overflow: "hidden", mx: 1 }}>
            <BenchmarkLogViewer urls={urls} current={current} height={height} />
          </Box>
        )}
      </Drawer>
    </Box>
  );
}

export function BenchmarkLogViewer({
  urls,
  current,
  height = "90vh",
}: {
  urls: LogSrc[];
  /** optional: scroll target like {fileIndex: 0, line: 42} (1-based line in that file) */
  current?: { fileIndex: number; line: number };
  height?: string | number;
}) {
  const keys = urls.map((u) => u.url);

  const { data: texts, error } = useSWRImmutable(
    keys.length ? ["logs", ...keys] : null,
    async (key) => {
      const [, ...list] = key;
      return Promise.all(list.map(fetchText));
    }
  );

  const labels = useMemo(
    () => urls.map((u, i) => u.label ?? u.url ?? `Log ${i + 1}`),
    [urls]
  );

  const combined = useMemo(() => {
    if (!texts) return { combined: "Loading...", offsets: [1] };
    return combineLogs(texts, labels);
  }, [texts, labels]);

  // Build editor state once data is ready
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
        foldUninteresting,
        codeFolding({
          placeholderText:
            "<probably uninteresting folded group, click to show>",
        }),
        search({ top: true }),
      ],
    });
  }, [combined.combined, height]);

  // Keep a single EditorView instance
  const viewerRef = useRef<HTMLDivElement>(null!);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!viewerRef.current) return;
    // Create view once
    if (!viewRef.current) {
      const v = new EditorView({
        state,
        parent: viewerRef.current,
      });
      viewRef.current = v;
      // Optionally fold all on first mount (when content is loaded later we'll fold again)
      foldAll(v);
    } else {
      // Replace entire state when extensions/doc changes (simplest & robust)
      viewRef.current.setState(state);
    }

    // After mounting/updating, optionally scroll
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
      // fold after content is real
      foldAll(v);
    }

    return () => {
      // Do NOT destroy here on update; only when unmounting the component
      // (React will call this when component unmounts)
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, texts, current?.fileIndex, current?.line]);

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, []);

  if (error) {
    return (
      <div style={{ color: "tomato" }}>
        Failed to load logs: {String(error)}
      </div>
    );
  }

  // Stop propagation to avoid parent click handlers (keeps your previous behavior)
  return <div ref={viewerRef} onDoubleClick={(e) => e.stopPropagation()} />;
}

export function LogUrlList({ urls }: { urls: LogSrc[] }) {
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        {`# Combine ${urls.length} logs for fast search `}
      </Typography>
      <Box>
        {urls.map((u, i) => (
          <Box
            key={i}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              py: 0.5,
              borderBottom: "1px solid",
              borderColor: "divider",
            }}
          >
            <Typography
              variant="body2"
              sx={{ minWidth: 60, flexShrink: 0, fontWeight: 500 }}
            >
              {u.label ?? `Log ${i + 1}`}
            </Typography>
            <Link
              href={u.url}
              target="_blank"
              rel="noopener"
              underline="hover"
              sx={{
                fontSize: "0.8rem",
                wordBreak: "break-all",
                color: "text.secondary",
              }}
            >
              {u.url}
            </Link>
            <Button onClick={}>jump to search</Button>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export function cmJumpToFirstMatch(
  view: EditorView,
  query: string | RegExp,
  opts: { caseSensitive?: boolean } = {}
): boolean {
  const text = view.state.doc.toString();
  let m: RegExpMatchArray | null = null;

  if (typeof query === "string") {
    const flags = opts.caseSensitive ? "g" : "gi";
    // Escape the string into a safe regex
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    m = text.match(new RegExp(escaped, flags));
    if (!m) return false;
    // We need the index; rematch to get it
    const re = new RegExp(escaped, flags);
    const idx = text.search(re);
    if (idx < 0) return false;
    view.dispatch({
      selection: { anchor: idx },
      scrollIntoView: true,
    });
    view.focus();
    return true;
  } else {
    const re = query;
    const idx = text.search(re);
    if (idx < 0) return false;
    view.dispatch({
      selection: { anchor: idx },
      scrollIntoView: true,
    });
    view.focus();
    return true;
  }
}
