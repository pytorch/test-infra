import { Box, Typography, useTheme } from "@mui/material";
import { headerBandColor } from "lib/tests/headerColors";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

// How to write a rates file, as the cost panel shows it: the plain form and
// the wrapped one side by side, with the window's largest runners as the
// examples' keys, and under them what keys, values and a usage window mean.
// As wide as that takes, so a caller can center it.
export default function RatesFormat({
  exampleLabels,
  runners,
}: {
  // The window's largest runners, and how many ran.
  exampleLabels: string[];
  runners: number;
}) {
  const theme = useTheme();
  const [a = "runner.label.a", b = "runner.label.b"] = exampleLabels;
  const pre = {
    m: 0,
    mt: 0.5,
    px: 1.25,
    py: 1,
    borderRadius: "4px",
    backgroundColor: headerBandColor(theme),
    fontFamily: MONO,
    fontSize: "0.75rem",
    lineHeight: 1.45,
    whiteSpace: "pre",
  };
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: {
          xs: "minmax(0, 1fr)",
          sm: "max-content max-content",
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
      <Box>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          Runner label → $ per runner-hour
        </Typography>
        <Box component="pre" sx={pre}>
          {`{\n  "${a}": 1.23,\n  "${b}": 4.56\n}`}
        </Box>
      </Box>
      <Box>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          Or wrapped, with optional notes
        </Typography>
        <Box component="pre" sx={pre}>
          {`{\n  "valid_from": "2026-10-01",\n  "window": {\n    "start": "2026-09-02",\n    "end": "2026-10-01"\n  },\n  "basis": "how the rates were made",\n  "rates": {\n    "${a}": 1.23,\n    "${b}": 4.56\n  }\n}`}
        </Box>
      </Box>
      <Box
        component="ul"
        sx={{
          gridColumn: "1 / -1",
          m: 0,
          pl: 2.25,
          color: "text.secondary",
          "& li + li": { mt: 0.5 },
        }}
      >
        <li>
          <b>Keys:</b> runner labels from runs-on, minus self-hosted ({runners}{" "}
          ran in this window).
        </li>
        <li>
          <b>Values:</b> $ per runner-hour, ≥ 0 (0 is free). Runners left out
          aren&apos;t priced.
        </li>
        <li>
          <b>Usage window:</b> the UTC days of usage the rates are averaged
          over, start and end both included.
        </li>
        <li>The values above are examples only.</li>
      </Box>
    </Box>
  );
}
