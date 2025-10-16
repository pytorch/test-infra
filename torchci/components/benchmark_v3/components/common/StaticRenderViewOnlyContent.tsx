import { Box, Chip, Divider, Stack, Typography } from "@mui/material";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

export function StaticRenderViewOnlyContent({
  data,
  title = "Content",
  maxDepth,
}: {
  data: JsonValue;
  title?: string;
  maxDepth?: number;
}) {
  return (
    <Box
      sx={{
        width: "100%",
        "& .mono": {
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        },
      }}
    >
      <SectionStatic
        name={title}
        value={data}
        maxDepth={maxDepth}
        depth={0}
        root
      />
    </Box>
  );
}

/* -------------------- internals -------------------- */

function isPlainObject(v: any): v is Record<string, JsonValue> {
  return v && typeof v === "object" && !Array.isArray(v);
}

// Render a static section reversively
// if maxDepth is set, it will render a summary instead of the content
function SectionStatic({
  name,
  value,
  depth,
  maxDepth,
  root = false,
}: {
  name: string;
  value: JsonValue;
  depth: number;
  maxDepth?: number;
  root?: boolean;
}) {
  const isObj = isPlainObject(value);
  const isArr = Array.isArray(value);

  if (maxDepth && depth >= maxDepth) {
    const summary = isArr
      ? `[Array(${(value as JsonValue[]).length})]`
      : "[Object]";
    return <LeafRow label={name} value={summary} />;
  }

  if (!isObj && !isArr) {
    return <LeafRow label={name} value={value} />;
  }

  // Section header (static, no toggle)
  return (
    <Box sx={{ pl: depth === 0 ? 0 : 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ py: 0.5 }}>
        <Typography
          variant={root ? "h6" : depth <= 1 ? "subtitle1" : "body1"}
          sx={{ fontWeight: 600 }}
        >
          {name}
        </Typography>
        {isArr ? (
          <Chip size="small" label={`[${(value as JsonValue[]).length}]`} />
        ) : null}
      </Stack>

      <Stack
        spacing={0.5}
        sx={{
          borderLeft: depth === 0 ? "none" : "1px solid rgba(0,0,0,0.08)",
          ml: 1.25,
          pl: 1.5,
        }}
      >
        {isObj &&
          Object.entries(value as Record<string, JsonValue>).map(([k, v]) => (
            <SectionStatic
              key={k}
              name={k}
              value={v}
              depth={depth + 1}
              maxDepth={maxDepth}
            />
          ))}
        {isArr &&
          (value as JsonValue[]).map((v, i) => (
            <SectionStatic
              key={i}
              name={`[${i}]`}
              value={v}
              depth={depth + 1}
              maxDepth={maxDepth}
            />
          ))}
      </Stack>
    </Box>
  );
}

function LeafRow({
  label,
  value,
}: {
  label: string;
  value: Exclude<JsonValue, object | any[]>;
}) {
  return (
    <Stack
      direction="row"
      alignItems="baseline"
      spacing={1}
      sx={{ px: 2, py: 0.25 }}
    >
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{
          width: 220,
          flexShrink: 0,
          pr: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </Typography>
      <Divider flexItem sx={{ mx: 1, opacity: 0.2 }} />
      <Typography
        variant="body2"
        className="mono"
        sx={{ wordBreak: "break-word" }}
      >
        {formatValue(value)}
      </Typography>
    </Stack>
  );
}

function formatValue(v: any) {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return String(v);
}
