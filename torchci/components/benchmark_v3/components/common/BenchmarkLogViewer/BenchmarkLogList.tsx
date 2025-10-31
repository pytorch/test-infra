import { Button, Divider, Link, TextField, Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";
import { LogSrc } from "./BenchmarkLogViewer";
import { EditorView } from "@codemirror/view";
import { Fragment } from "react";

export function LogUrlList({
  urls,
  viewRef,
  query,
  setQuery,
}: {
  urls: LogSrc[];
  viewRef: React.MutableRefObject<EditorView | null>;
  query: string;
  setQuery: (s: string) => void;
}) {
  return (
    <Box>
      <TextField
        fullWidth
        size="small"
        placeholder="Search label / url / info…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        sx={{ mb: 1 }}
      />
      <Box sx={{ maxHeight: 300, overflowY: "auto", pr: 1 }}>
        {urls.map((u, i) => (
          <Fragment key={`${u.url}-${i}`}>
            <Stack>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography
                  variant="body2"
                  sx={{ minWidth: 60, fontWeight: 600 }}
                >
                  {highlightChunks(u.label ?? `Log ${i + 1}`, query)}
                </Typography>
                <Button
                  size="small"
                  onClick={() => {
                    const q = query.trim() || u.url;
                    if (viewRef.current) {
                      // your existing helper
                      cmJumpToFirstMatch(viewRef.current, q);
                    }
                  }}
                >
                  jump to search
                </Button>
              </Stack>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography variant="caption">Source:</Typography>
                <Link
                  href={u.url}
                  target="_blank"
                  rel="noopener"
                  underline="hover"
                  sx={{
                    fontSize: "0.8rem",
                    wordBreak: "break-all",
                    color: "text.secondary",
                    flex: 1,
                  }}
                >
                  {highlightChunks(u.url, query)}
                </Link>
              </Stack>
              {u.info && (
                <Stack sx={{ mt: 0.5 }}>
                  <Typography variant="caption" sx={{ fontWeight: 600 }}>
                    Info:
                  </Typography>
                  {Object.entries(u.info).map(([k, v]) => {
                    const vs = Array.isArray(v) ? v.join(", ") : String(v);
                    return (
                      <Box key={k} sx={{ display: "flex", gap: 1, ml: 2 }}>
                        <Typography variant="caption" sx={{ fontWeight: 500 }}>
                          {highlightChunks(`${k}:`, query)}
                        </Typography>
                        <Typography
                          variant="caption"
                          sx={{ color: "text.secondary" }}
                        >
                          {highlightChunks(vs, query)}
                        </Typography>
                      </Box>
                    );
                  })}
                </Stack>
              )}
            </Stack>
            <Divider sx={{ my: 1 }} />
          </Fragment>
        ))}
      </Box>
    </Box>
  );
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


export function cmJumpToFirstMatch(
  view: EditorView | null,
  query: string | RegExp,
  opts: { caseSensitive?: boolean } = {}
): boolean {
  if (!view) return false;

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
