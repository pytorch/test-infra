import { Box, Typography } from "@mui/material";
import InlineSelect from "components/tests/InlineSelect";
import {
  COST_WINDOW_LABELS,
  COST_WINDOWS,
  type CostWindow,
} from "lib/api/tests/cost/windows";

const WINDOW_OPTIONS = COST_WINDOWS.map((value) => ({
  value,
  label: COST_WINDOW_LABELS[value],
}));

// The title is a sentence saying what the page counts, whose, and over which
// days, as the tests page's is: "Runner-hours of pytorch/pytorch over the last
// 7 days", the window its pill (InlineSelect). The workflow scope and what the
// hours cover are said by the facts under it.
export default function CostHeading({
  repo,
  window,
  onWindowChange,
}: {
  repo: string | undefined;
  window: CostWindow;
  onWindowChange: (_window: CostWindow) => void;
}) {
  return (
    <Typography variant="h4" component="h1" sx={{ lineHeight: 1.5 }}>
      {repo === undefined ? (
        "CI cost"
      ) : (
        <>
          Runner-hours of{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {repo}
          </Box>{" "}
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
    </Typography>
  );
}
