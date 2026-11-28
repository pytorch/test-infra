import { Box, Typography, useTheme } from "@mui/material";
import { headerBandColor } from "lib/tests/headerColors";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

// The two examples, as text: each is a file the page reads (rateStrip.test).
export function formatExamples(exampleLabels: readonly string[]): {
  rates: string;
  meta: string;
} {
  const [a = "runner.label.a", b = "runner.label.b"] = exampleLabels;
  return {
    rates: `{
  "basis": "how the rates were made",
  "periods": [
    {
      "valid_from": "2026-11-02",
      "valid_through": "2026-11-08",
      "rates": {
        "${a}": 1.23,
        "${b}": 4.56
      },
      "totals": {
        "aws_total": 1000000,
        "runner_nodes": 600000
      }
    },
    {
      "valid_from": "2026-11-09",
      "valid_through": "2026-11-15",
      "rates": {
        "${a}": 1.25,
        "${b}": 4.6
      }
    }
  ]
}`,
    meta: `{
  "generated_at": "2026-11-16T06:00:00Z",
  "periods": [
    {
      "valid_from": "2026-11-02",
      "status": "final",
      "window": {
        "start": "2026-11-02",
        "end": "2026-11-08"
      }
    },
    {
      "valid_from": "2026-11-09",
      "status": "provisional",
      "window": {
        "start": "2026-11-09",
        "end": "2026-11-13"
      }
    }
  ]
}`,
  };
}

// How to write a rates file of periods, as the rates control's
// Format popover shows it: rates.json and its optional rates.meta.json side
// by side, the window's largest runner labels as the keys, and under them
// what periods, recent days, the meta and older files mean.
export default function RatesFormatPeriods({
  exampleLabels,
}: {
  exampleLabels: string[];
}) {
  const theme = useTheme();
  const examples = formatExamples(exampleLabels);
  const pre = {
    m: 0,
    mt: 0.5,
    px: 1.25,
    py: 1,
    borderRadius: "4px",
    backgroundColor: headerBandColor(theme),
    color: "text.primary",
    fontFamily: MONO,
    fontSize: "0.75rem",
    lineHeight: 1.45,
    whiteSpace: "pre",
    overflowX: "auto",
  };
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: {
          xs: "minmax(0, 1fr)",
          md: "max-content max-content",
        },
        columnGap: 2,
        rowGap: 1.25,
        width: "fit-content",
        maxWidth: "100%",
        typography: "body2",
        textAlign: "left",
        "& b": { color: "text.primary", fontWeight: 600 },
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          rates.json: rate sets by period
        </Typography>
        <Box component="pre" sx={pre}>
          {examples.rates}
        </Box>
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          rates.meta.json (optional): status and source days
        </Typography>
        <Box component="pre" sx={pre}>
          {examples.meta}
        </Box>
      </Box>
      <Box
        component="ul"
        sx={{
          gridColumn: "1 / -1",
          m: 0,
          pl: 2.25,
          maxWidth: "88ch",
          color: "text.secondary",
          "& li + li": { mt: 0.5 },
        }}
      >
        <li>
          <b>Keys:</b> runner labels from runs-on, minus self-hosted.{" "}
          <b>Values:</b> $ per runner-hour, ≥ 0 (0 is free). Labels left out
          aren&apos;t priced.
        </li>
        <li>
          <b>Periods:</b> UTC days, valid_from through valid_through, both
          included, usually Monday–Sunday weeks. Any order, no overlaps. Each
          day is priced by its own period, never averaged. Only the days the
          periods list are priced: a day in none (a hole, or before the first or
          after the last period) stays unpriced and blank.
        </li>
        <li>
          <b>Recent days:</b> to price them, the file must list a period for
          them, e.g. the latest rates carried forward and marked provisional in
          the meta.
        </li>
        <li>
          <b>Totals (optional):</b> $ per period, Meta and LF accounts:
          aws_total = the whole bill; runner_nodes = runner instances, idle
          included.
        </li>
        <li>
          <b>Meta:</b> status final or provisional; window = the days the rates
          were made from. Drop it together with rates.json.
        </li>
        <li>
          <b>Older files:</b> a bare map, or {"{"}valid_from, window, basis,
          rates{"}"}, still loads as one set for every day.
        </li>
        <li>Up to 4 MB. The values above are examples only.</li>
      </Box>
    </Box>
  );
}
