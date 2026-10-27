import { Box, Skeleton, Tooltip, Typography } from "@mui/material";
import { durationLabel, integerLabel } from "lib/tests/table";
import type { PageTiming } from "lib/tests/useTestsListing";

// About as wide as "Loaded in 12.7 s" ("Loaded in 7.6 s" measured 98px at
// 14px; a second digit adds about 7px), so the label's row looks the same
// while a page loads and once it has.
const LOAD_TIME_WIDTH = "13.5ch";

export interface LoadTimeProps {
  // How long the page shown took to arrive; null while there is no page.
  timing: PageTiming | null;
  // A page is on its way.
  loading: boolean;
}

// How long the page shown took to load, as the caption that closes the
// table: "Loaded in 5.2 s" in the secondary color, hugging the grid's
// bottom-right corner under its footer, as "Updated" hugs its top-right
// corner. On hover, the exact figure and what of it the API spent in the
// database. A skeleton as wide as the label holds its row while a page is
// on its way, so each sort, filter, search or page turn clears the label
// and fills it in again when the page arrives, and nothing below the table
// moves; a page that failed leaves the row empty.
export default function LoadTime({ timing, loading }: LoadTimeProps) {
  return (
    <Box sx={{ display: "flex", justifyContent: "flex-end", mt: 0.5 }}>
      <Tooltip
        title={
          timing === null
            ? ""
            : `The API answered in ${integerLabel(timing.elapsedMs)} ms.\n` +
              `The database query took ${integerLabel(
                timing.queryDurationMs
              )} ms of that.`
        }
        enterDelay={600}
        placement="top-end"
        slotProps={{ tooltip: { sx: { whiteSpace: "pre-line" } } }}
      >
        <Typography
          variant="body2"
          component="p"
          sx={{
            color: "text.secondary",
            whiteSpace: "nowrap",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {timing !== null ? (
            <>Loaded in {durationLabel(timing.elapsedMs)}</>
          ) : loading ? (
            <Skeleton variant="text" sx={{ width: LOAD_TIME_WIDTH }} />
          ) : (
            "\u00a0"
          )}
        </Typography>
      </Tooltip>
    </Box>
  );
}
