import { EditorView } from "@codemirror/view";
import {
  Autocomplete,
  Button,
  Chip,
  Divider,
  Link,
  TextField,
  Typography,
} from "@mui/material";
import { Box, Stack } from "@mui/system";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { LogSrc } from "./BenchmarkLogViewer";

export function LogUrlList({
  urls,
  viewRef,
  query,
  setQuery,
  width = "80vw",
  height = "90vh",
}: {
  urls: LogSrc[];
  viewRef: React.MutableRefObject<EditorView | null>;
  query: string;
  setQuery: (s: string) => void;
  width?: any;
  height?: any;
}) {
  // chips state (derived from query initially)
  const [terms, setTerms] = useState<string[]>(
    query
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)
  );
  const [inputValue, setInputValue] = useState("");

  // keep external query string loosely in sync (optional)
  useEffect(() => {
    setQuery(terms.join(" "));
  }, [terms, setQuery]);

  // normalized chips (dedupe + lowercase)
  const normTerms = useMemo(
    () =>
      Array.from(new Set(terms.map((t) => t.toLowerCase()).filter(Boolean))),
    [terms]
  );

  const filtered = useMemo(() => {
    if (!normTerms.length) return urls;
    return urls.filter((u) => {
      const hay = buildHaystack(u);
      const result = normTerms.every((t) => hay.includes(t));
      return result;
    });
  }, [urls, normTerms]);

  const jumpRegex = useMemo(() => {
    if (!normTerms.length) return null;
    return new RegExp(`(${normTerms.map(escapeRegExp).join("|")})`, "i");
  }, [normTerms]);

  // add a term from the current input
  const commitInputAsTerm = useCallback(() => {
    const t = inputValue.trim();
    if (!t) return;
    if (!terms.includes(t)) setTerms((prev) => [...prev, t]);
    setInputValue("");
  }, [inputValue, terms]);

  return (
    <Box width={width}>
      <Autocomplete
        multiple
        freeSolo
        options={[]} // no predefined options; it's a tag input
        value={terms}
        inputValue={inputValue}
        onInputChange={(_e, v) => setInputValue(v)}
        onChange={(_e, newValue) => setTerms(newValue)}
        renderTags={(value, getTagProps) =>
          value.map((option, index) => (
            <Chip
              variant="outlined"
              size="small"
              label={option}
              {...getTagProps({ index })}
              key={`${option}-${index}`}
            />
          ))
        }
        renderInput={(params) => (
          <TextField
            {...params}
            size="small"
            placeholder="Search label / url / info…"
            onKeyDown={(e) => {
              if (["Enter", " ", "Comma"].includes(e.key) || e.key === ",") {
                e.preventDefault();
                commitInputAsTerm();
              }
            }}
            sx={{ m: 1 }}
          />
        )}
      />

      <Box sx={{ height: height, overflowY: "auto", pr: 1, minWidth: 0 }}>
        {filtered.map((u, i) => (
          <Fragment key={`${u.url}-${i}`}>
            <Stack>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography
                  variant="body2"
                  sx={{ minWidth: 60, fontWeight: 600 }}
                >
                  {highlightChunksMulti(u.label ?? `Log ${i + 1}`, terms)}
                </Typography>
                <Button
                  size="small"
                  onClick={() => {
                    const fallback = u.url;
                    cmJumpToFirstMatch(viewRef.current, fallback);
                  }}
                >
                  jump to head of log
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
                  {highlightChunksMulti(u.url, terms)}
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
                          {highlightChunksMulti(`${k}:`, terms)}
                        </Typography>
                        <Typography
                          variant="caption"
                          sx={{ color: "text.secondary" }}
                        >
                          {highlightChunksMulti(vs, terms)}
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

// Flatten any nested info into plain strings
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
      flattenInfo(v, out);
    }
  }
  return out;
}

function buildHaystack(u: LogSrc): string {
  const parts = [u.label ?? "", u.url ?? "", ...flattenInfo(u.info ?? {})];
  return parts.join(" ").toLowerCase();
}

// Highlight ALL chips
function highlightChunksMulti(text: string, terms: string[]): React.ReactNode {
  if (!terms?.length) return text;
  const pattern = new RegExp(terms.map(escapeRegExp).join("|"), "ig");
  const out: React.ReactNode[] = [];
  let last = 0,
    m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const start = m.index,
      end = start + m[0].length;
    if (start > last) out.push(text.slice(last, start));
    out.push(<mark key={`${start}-${end}`}>{text.slice(start, end)}</mark>);
    last = end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Jump helper (unchanged)
export function cmJumpToFirstMatch(
  view: EditorView | null,
  query: string | RegExp,
  opts: { caseSensitive?: boolean } = {}
): boolean {
  if (!view) return false;
  const text = view.state.doc.toString();
  if (typeof query === "string") {
    const idx = text.search(
      new RegExp(escapeRegExp(query), opts.caseSensitive ? "" : "i")
    );
    if (idx < 0) return false;
    view.dispatch({ selection: { anchor: idx }, scrollIntoView: true });
    view.focus();
    return true;
  }
  const idx = text.search(query);
  if (idx < 0) return false;
  view.dispatch({ selection: { anchor: idx }, scrollIntoView: true });
  view.focus();
  return true;
}
