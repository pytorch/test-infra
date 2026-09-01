import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Box,
  Chip,
  Collapse,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import { durationDisplay } from "components/common/TimeUtils";
import L3SummaryChip from "components/crcr/L3SummaryChip";
import { fetcherHandleError } from "lib/GeneralUtils";
import {
  buildCriteriaRows,
  buildDemotionRows,
  CriterionRow,
  L3Metrics,
  mergeCriteriaRows,
  useTenure,
} from "lib/crcr/l3Readiness";
import {
  L3_DEMOTION_WINDOW_DAYS,
  L3_PROMOTION_WINDOW_DAYS,
  useL3VerdictColors,
} from "lib/crcr/l3Thresholds";
import { useMemo, useState } from "react";
import useSWR from "swr";

function formatMeasured(row: CriterionRow): string {
  if (row.measured == null) return "–";
  switch (row.format) {
    case "days":
      return row.detail
        ? `${row.measured.toFixed(0)} days (${row.detail})`
        : `${row.measured.toFixed(0)} days`;
    case "duration":
      return durationDisplay(Math.round(row.measured));
    case "percent":
      return `${(row.measured * 100).toFixed(1)}%`;
  }
}

// Measured value colored by verdict — the value itself carries the signal,
// no separate checkmark column needed. Each column only highlights the
// state worth acting on: Promotion turns green when a criterion qualifies
// (the notable event — go promote), Demotion turns red when a criterion
// would trigger demotion (the notable event — go fix it). The unremarkable
// state in either column (not yet promotable / not at risk) stays the
// default text color instead of also being colored.
function VerdictValue({
  row,
  variant,
}: {
  row: CriterionRow | null;
  variant: "promotion" | "demotion";
}) {
  const { pass, fail } = useL3VerdictColors();
  if (!row) {
    return (
      <Typography variant="body2" color="text.disabled">
        n/a
      </Typography>
    );
  }
  if (row.verdict == null) {
    return (
      <Typography variant="body2" color="text.disabled">
        {formatMeasured(row)}
      </Typography>
    );
  }
  const notable = variant === "promotion" ? row.verdict : !row.verdict;
  const color = notable ? (variant === "promotion" ? pass : fail) : undefined;
  return (
    <Typography variant="body2" sx={{ color, fontWeight: notable ? 600 : 400 }}>
      {formatMeasured(row)}
    </Typography>
  );
}

// crcr_backend_summary, filtered server-side to one repo — a bloom filter
// index on downstream_repo makes this cheap. Avoids crcr_l3_summary (the
// all-repo query the /crcr at-a-glance column needs) here, which would
// scan every registered repo's data just to keep the one row this panel
// actually uses. Same query + params SummaryCards above uses for the
// promotion window, so SWR dedupes that fetch too.
function useL3Summary(days: number, repoFullName: string) {
  const url = `/api/clickhouse/crcr_backend_summary?parameters=${encodeURIComponent(
    JSON.stringify({ repo: repoFullName, days: String(days) })
  )}`;
  const { data, error } = useSWR<L3Metrics[]>(url, fetcherHandleError, {
    refreshInterval: 60_000,
  });
  const summary = useMemo(() => data?.[0] ?? null, [data]);
  return { summary, loaded: !!data || !!error };
}

export default function CrcrL3Readiness({
  repoFullName,
}: {
  repoFullName: string;
}) {
  // Promotion and demotion shown as one table (same criteria, same
  // thresholds where they overlap) instead of a toggle or two separate
  // tables — each column is just evaluated over its own fixed window.
  const promotion = useL3Summary(L3_PROMOTION_WINDOW_DAYS, repoFullName);
  const demotion = useL3Summary(L3_DEMOTION_WINDOW_DAYS, repoFullName);
  const tenure = useTenure(repoFullName);
  const [expanded, setExpanded] = useState(false);

  if (!promotion.loaded || !demotion.loaded || !tenure.loaded) {
    return <Skeleton variant="rectangular" height={80} />;
  }

  const promotionRows = buildCriteriaRows(promotion.summary, tenure.tenure);
  const demotionRows = buildDemotionRows(demotion.summary);
  const rows = mergeCriteriaRows(promotionRows, demotionRows);

  return (
    <Paper elevation={1} sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Box
          display="flex"
          justifyContent="space-between"
          alignItems="center"
          flexWrap="wrap"
          gap={1}
          sx={{ cursor: "pointer" }}
          onClick={() => setExpanded((e) => !e)}
        >
          <Stack spacing={0.5}>
            <Typography variant="h6">L3 Readiness</Typography>
            <Chip
              label={expanded ? "Hide details" : "Details"}
              size="small"
              color="primary"
              variant={expanded ? "filled" : "outlined"}
              clickable
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              deleteIcon={
                <ExpandMoreIcon
                  sx={{
                    transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                    transition: "transform 0.2s",
                  }}
                />
              }
              onDelete={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              sx={{ width: "fit-content" }}
            />
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center">
            <L3SummaryChip
              label="Promotion"
              rows={promotionRows}
              variant="promotion"
            />
            <L3SummaryChip
              label="Demotion"
              rows={demotionRows}
              variant="demotion"
            />
          </Stack>
        </Box>

        <Collapse in={expanded} timeout="auto" unmountOnExit>
          <Stack spacing={1.5}>
            <Typography variant="caption" color="text.secondary">
              Promotion is evaluated over the last {L3_PROMOTION_WINDOW_DAYS}{" "}
              days, demotion over the last {L3_DEMOTION_WINDOW_DAYS} days.
            </Typography>

            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>
                      <strong>Criterion</strong>
                    </TableCell>
                    <TableCell align="right">
                      <strong>Target</strong>
                    </TableCell>
                    <TableCell align="right">
                      <strong>Promotion ({L3_PROMOTION_WINDOW_DAYS}d)</strong>
                    </TableCell>
                    <TableCell align="right">
                      <strong>Demotion ({L3_DEMOTION_WINDOW_DAYS}d)</strong>
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.key}>
                      <TableCell>
                        {r.criterion}
                        {r.provisional && (
                          <Tooltip title="Provisional — value pending a future spec amendment">
                            <Typography
                              component="span"
                              variant="caption"
                              color="text.secondary"
                              sx={{ ml: 0.5, cursor: "help" }}
                            >
                              (provisional)
                            </Typography>
                          </Tooltip>
                        )}
                        {r.key === "tenureAtL2Days" &&
                          r.promotion.measured == null && (
                            <Tooltip title="No tenure data for this repo yet">
                              <Typography
                                component="span"
                                variant="caption"
                                color="text.secondary"
                                sx={{ ml: 0.5, cursor: "help" }}
                              >
                                (no data)
                              </Typography>
                            </Tooltip>
                          )}
                      </TableCell>
                      <TableCell align="right">{r.targetLabel}</TableCell>
                      <TableCell align="right">
                        <VerdictValue row={r.promotion} variant="promotion" />
                      </TableCell>
                      <TableCell align="right">
                        <VerdictValue row={r.demotion} variant="demotion" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Stack>
        </Collapse>
      </Stack>
    </Paper>
  );
}
