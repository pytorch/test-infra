import { Grid, Paper, Stack, Typography } from "@mui/material";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import {
  approvedRevertRows,
  revertRows,
  staleVerdictNote,
} from "lib/greenlight/qualityFigures";
import {
  GREENLIGHT_QUALITY_REPO,
  QUALITY_QUERIES,
  useQualityQuery,
} from "lib/greenlight/qualityQuery";
import { useMemo } from "react";
import InfoTooltip from "./InfoTooltip";
import { REVERTED_TABLE } from "./tableConfigs";

const TABLE_HEIGHT = 460;

// Shares the reverts SWR key with the revert tile; this view narrows the same
// rows to the ones GreenLight actually approved.
export default function RevertedTable({
  startTime,
  stopTime,
  autoRefresh,
}: {
  startTime: string;
  stopTime: string;
  autoRefresh: boolean;
}) {
  const reverts = useQualityQuery(
    QUALITY_QUERIES.reverts,
    startTime,
    stopTime,
    autoRefresh
  );

  // A fresh array identity on every render would remount the grid's rows, and
  // a wide window returns reverts in the thousands.
  const rows = useMemo(() => approvedRevertRows(reverts.rows), [reverts.rows]);
  const staleness = useMemo(() => staleVerdictNote(rows), [rows]);

  // Counted here rather than inside the slots memo below, which depends on this
  // number and must not depend on the row array: a memo keyed on rows.length alone
  // would hold a stale message whenever the rows change without changing count.
  const revertCount = useMemo(
    () => revertRows(reverts.rows).length,
    [reverts.rows]
  );

  // The grid's stock "No rows" reads the same for a window that held no reverts
  // and for one whose reverts GreenLight never approved. The second is the
  // result this table exists to report, and it must not look like missing data.
  // Memoised because a fresh slot component identity remounts the overlay.
  const slots = useMemo(() => {
    const message =
      revertCount === 0
        ? "No reverts in this window."
        : "No GreenLight-approved reverts in this window.";
    return {
      noRowsOverlay: () => (
        <Stack height="100%" alignItems="center" justifyContent="center">
          <Typography variant="body2" color="text.secondary">
            {message}
          </Typography>
        </Stack>
      ),
    };
  }, [revertCount]);

  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12 }} height={TABLE_HEIGHT}>
        {reverts.error !== undefined ? (
          <Paper elevation={3} sx={{ p: 2, height: "100%" }}>
            <Typography variant="subtitle2" color="text.secondary">
              {REVERTED_TABLE.heading}
            </Typography>
            <Typography variant="body2" color="error.main" sx={{ mt: 1 }}>
              {reverts.error}
            </Typography>
          </Paper>
        ) : (
          <TablePanelWithData
            // TablePanelWithData wraps the title in a <p>, so this subtitle
            // stays inline-level rather than nesting a div inside it.
            title={
              <Stack
                component="span"
                direction="row"
                alignItems="center"
                spacing={0.5}
              >
                <span>{REVERTED_TABLE.heading}</span>
                <InfoTooltip
                  label={REVERTED_TABLE.heading}
                  paragraphs={[staleness]}
                />
              </Stack>
            }
            data={reverts.loading ? undefined : rows}
            columns={REVERTED_TABLE.columns}
            showFooter={true}
            dataGridProps={{
              slots,
              getRowId: REVERTED_TABLE.getRowId,
              onRowClick: (params: { row: any }) =>
                window.open(
                  `https://github.com/${GREENLIGHT_QUALITY_REPO}/pull/${params.row.pr_number}`,
                  "_blank",
                  "noreferrer"
                ),
              sx: { "& .MuiDataGrid-row": { cursor: "pointer" } },
              initialState: {
                sorting: {
                  sortModel: [
                    { field: REVERTED_TABLE.defaultSortField, sort: "desc" },
                  ],
                },
              },
            }}
          />
        )}
      </Grid>
    </Grid>
  );
}
