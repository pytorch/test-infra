import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import {
  Autocomplete,
  Button,
  Chip,
  Divider,
  IconButton,
  Link,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { Box, Stack } from "@mui/system";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { LogSrc } from "./BenchmarkLogViewContent";
export function LogUrlList({
  urls,
  viewRef,
  query,
  setQuery,
  width = "80vw",
  height = "60vh",
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

  // keep external query string loosely in sync
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
      return normTerms.every((t) => hay.includes(t));
    });
  }, [urls, normTerms]);

  // add a term from the current input
  const commitInputAsTerm = useCallback(() => {
    const t = inputValue.trim();
    if (!t) return;
    if (!terms.includes(t)) setTerms((prev) => [...prev, t]);
    setInputValue("");
  }, [inputValue, terms]);

  const removeAt = useCallback(
    (idx: number) => setTerms((prev) => prev.filter((_, i) => i !== idx)),
    []
  );

  return (
    <Box width={width}>
      <Autocomplete<string, true, false, true>
        multiple
        freeSolo
        options={[] as string[]}
        value={terms}
        inputValue={inputValue}
        onInputChange={(_e, v) => setInputValue(v)}
        onChange={(_e, newValue) => setTerms(newValue)}
        renderValue={(selected /* string[] */) => (
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, m: 1 }}>
            {selected.map((option, idx) => (
              <Chip
                key={`${option}-${idx}`}
                variant="outlined"
                size="small"
                label={option}
                onDelete={() => removeAt(idx)}
              />
            ))}
          </Box>
        )}
        renderInput={(params) => (
          <TextField
            {...params}
            size="small"
            placeholder="Search label / url / info…"
            onKeyDown={(e) => {
              if (["Enter", " ", "Comma"].includes(e.key) || e.key === ",") {
                e.preventDefault();
                commitInputAsTerm();
                return;
              }
              if (e.key === "Backspace" && !inputValue && terms.length > 0) {
                e.preventDefault();
                removeAt(terms.length - 1);
              }
            }}
            sx={{ m: 1 }}
          />
        )}
      />
      <SearchTipsTooltip />
      <Divider sx={{ my: 1 }} />
      <Box
        sx={{
          height,
          minHeight: "10vh",
          overflowY: "auto",
          pr: 1,
          minWidth: 0,
        }}
      >
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
                    const v = viewRef.current;
                    if (!v) return;
                    const fallback = u.url || "";
                    cmJumpToFirstMatch(v, fallback);
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
      <Divider sx={{ my: 1 }} />
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

// Jump helper
export function cmJumpToFirstMatch(
  view: EditorView | null,
  query: string | RegExp,
  opts: { caseSensitive?: boolean } = {}
): boolean {
  if (!view) return false;
  const text = view.state.doc.toString();

  const re =
    typeof query === "string"
      ? new RegExp(escapeRegExp(query), opts.caseSensitive ? "" : "i")
      : query;

  const m = text.match(re);
  if (!m || m.index == null) return false;

  const from = m.index;
  const to = from + m[0].length;
  view.dispatch({
    selection: EditorSelection.single(from, to),
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

export function SearchTipsTooltip() {
  return (
    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ ml: 1 }}>
      <Typography variant="body2" sx={{ mr: 0.5 }}>
        Search Tips:
      </Typography>
      <Tooltip
        title={<SearchTipsContent />}
        placement="top"
        arrow
        slotProps={{
          tooltip: {
            sx: {
              bgcolor: "background.paper",
              color: "text.primary",
              boxShadow: 3,
              p: 1.2,
            },
          },
        }}
      >
        <IconButton size="small">
          <InfoOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

function SearchTipsContent() {
  return (
    <Box sx={{ mx: 1.5, mt: 0.5, color: "text.secondary" }}>
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <InfoOutlinedIcon fontSize="small" sx={{ mt: "2px", opacity: 0.8 }} />
        <Box>
          <Typography variant="caption" sx={{ display: "block" }}>
            <b>Search scope:</b> search all values in info section & source
            section below.
          </Typography>
          <Typography variant="caption" sx={{ display: "block", mt: 0.25 }}>
            <b>How to filter:</b> type terms and press <b>Enter</b>/<b>Space</b>
            /<b>,</b>. Multiple terms are combined with <b>AND</b>.
          </Typography>
          {/* optional: small examples row */}
          <Stack
            direction="row"
            spacing={0.5}
            sx={{ mt: 0.5, flexWrap: "wrap" }}
          >
            <Typography variant="caption" sx={{ mr: 0.5 }}>
              Examples:
            </Typography>
            <Chip size="small" variant="outlined" label="timm_models" />
            <Chip size="small" variant="outlined" label="adv_inception_v3" />
          </Stack>
          <Typography variant="caption" sx={{ display: "block", mt: 0.25 }}>
            <b>Field option coverage:</b> the available fields (e.g.{" "}
            <code>model</code>, <code>arch</code>) reflect your <i>main page</i>{" "}
            filters and may not be the full list of content in the log.
          </Typography>
        </Box>
      </Stack>
    </Box>
  );
}
