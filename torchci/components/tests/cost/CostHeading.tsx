import { Box, Typography, useTheme } from "@mui/material";
import InlineSelect from "components/tests/InlineSelect";
import { VIEW_CHIP_HEIGHT } from "components/tests/ViewChips";
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
const TITLE_LINE_HEIGHT = 1.5;

// The title is a sentence saying what the page counts, whose, and over which
// days, as the tests page's is: "Runner-hours of pytorch/pytorch over the last
// 7 days", the window its pill (InlineSelect). Without a window it names only
// what and whose, "Runner-hours of pytorch/pytorch", where the trends below
// pick the days. The `keys` (the workflow scope, the rates file), groups of
// controls one height, sit at the title's right end, wrapping under it as
// groups. The workflow scope and what the hours cover are said under it.
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
  const theme = useTheme();
  const title = (
    <Typography
      variant="h4"
      component="h1"
      sx={{ lineHeight: TITLE_LINE_HEIGHT }}
    >
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
        alignItems: "flex-start",
        columnGap: 2,
      }}
    >
      {title}
      <Box sx={{ ml: "auto" }} />
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          // Every key is a control's height: their tops line up, and an
          // error line under the rates leaves the rest in place. The first
          // line is padded to sit centred on the title's, whatever the
          // error line adds below it.
          alignItems: "flex-start",
          pt: `calc((${theme.typography.h4.fontSize} * ${TITLE_LINE_HEIGHT} - ${VIEW_CHIP_HEIGHT}px) / 2)`,
          columnGap: 2,
          rowGap: 1,
          minWidth: 0,
        }}
      >
        {keys}
      </Box>
    </Box>
  );
}
