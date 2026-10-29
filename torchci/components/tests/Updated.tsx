import { Box, Skeleton, Tooltip, Typography } from "@mui/material";
import { useTimeAgo } from "components/tests/TimeAgo";

// How often the health table is rebuilt, as REFRESH EVERY 15 MINUTE in
// clickhouse_db_schema/ci/000002-health-materialized-view.sql has it.
const REFRESHED_EVERY = "15 minutes";
// About as wide as "Updated 15 mins ago" (measured 136px at 14px), so the
// label's row is the same width before and after the label arrives.
const UPDATED_WIDTH = "17.5ch";

// When the table's data was last refreshed, as the table's caption: "Updated
// 5 mins ago" in the secondary color, at the right end of the caption's line
// above the table's top-right corner, with the exact time and the refresh
// cadence on hover. A skeleton as wide as the label holds its place until
// the first page, so the table does not move when the label appears.
export default function Updated({
  refreshedAt,
}: {
  refreshedAt: string | null;
}) {
  const time = useTimeAgo(refreshedAt);
  return (
    <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
      <Tooltip
        title={
          time === undefined
            ? ""
            : `Refreshed ${time.when}.\nThe data is refreshed every ${REFRESHED_EVERY}.`
        }
        enterDelay={600}
        placement="bottom-end"
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
          {time === undefined ? (
            <Skeleton variant="text" sx={{ width: UPDATED_WIDTH }} />
          ) : (
            <>Updated {time.ago}</>
          )}
        </Typography>
      </Tooltip>
    </Box>
  );
}
