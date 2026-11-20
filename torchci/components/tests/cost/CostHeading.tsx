import { Box, Typography } from "@mui/material";
import InlineSelect from "components/tests/InlineSelect";
import {
  COST_WINDOW_LABELS,
  COST_WINDOWS,
  type CostWindow,
} from "lib/api/tests/cost/windows";
import type { ReactNode } from "react";

const WINDOW_OPTIONS = COST_WINDOWS.map((value) => ({
  value,
  label: COST_WINDOW_LABELS[value],
}));

// The title is a sentence saying what the page counts, whose, and over which
// days, as the tests page's is: "Runner-hours of pytorch/pytorch over the last
// 7 days", the window its pill (InlineSelect). Without a window it names only
// what and whose, "Runner-hours of pytorch/pytorch", where the trends below
// pick the days. The `keys` (the workflow scope, the rates file) sit at the
// title's right end. The workflow scope and what the hours cover are said
// under it.
export default function CostHeading({
  repo,
  window,
  onWindowChange,
  keys,
}: {
  repo: string | undefined;
  window?: CostWindow;
  onWindowChange?: (_window: CostWindow) => void;
  keys?: ReactNode;
}) {
  const title = (
    <Typography variant="h4" component="h1" sx={{ lineHeight: 1.5 }}>
      {repo === undefined ? (
        "CI cost"
      ) : (
        <>
          Runner-hours of{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {repo}
          </Box>
          {window !== undefined && onWindowChange !== undefined && (
            <>
              {" "}
              over the last{" "}
              <InlineSelect
                label="Window"
                display={COST_WINDOW_LABELS[window]}
                options={WINDOW_OPTIONS}
                value={window}
                onChange={onWindowChange}
              />
            </>
          )}
        </>
      )}
    </Typography>
  );
  if (keys === undefined) return title;
  return (
    <Box
      sx={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        columnGap: 2,
        rowGap: 1,
      }}
    >
      {title}
      <Box sx={{ ml: "auto" }} />
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>{keys}</Box>
    </Box>
  );
}
