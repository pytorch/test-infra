import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Box,
  Chip,
  Collapse,
  Link,
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
import L3SummaryChip from "components/crcr/L3SummaryChip";
import { fetcherHandleError } from "lib/GeneralUtils";
import {
  buildCriteriaRows,
  buildDemotionRows,
  buildOperationalBaselineRows,
  CriterionRow,
  formatMeasured,
  getL3ProtectionStatus,
  L3Metrics,
  mergeCriteriaRows,
  useTenure,
} from "lib/crcr/l3Readiness";
import {
  L3_DEMOTION_WINDOW_DAYS,
  L3_PROMOTION_WINDOW_DAYS,
  useL3VerdictColors,
} from "lib/crcr/l3Thresholds";
import { levelPolicyPresentation, type CrcrLevel } from "lib/crcr/levelPolicy";
import type { AllowlistResponse } from "pages/api/crcr/allowlist";
import { useMemo, useState } from "react";
import useSWR from "swr";

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
  return {
    summary,
    error,
    loaded: !!data || !!error,
  };
}

function configuredLevel(
  allowlist: AllowlistResponse | undefined,
  repoFullName: string
): CrcrLevel | null {
  if (!allowlist) return null;
  for (const level of ["L1", "L2", "L3", "L4"] as CrcrLevel[]) {
    if (allowlist[level].some((entry) => entry.repo === repoFullName)) {
      return level;
    }
  }
  return null;
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
  const { data: allowlist } = useSWR<AllowlistResponse>(
    "/api/crcr/allowlist",
    fetcherHandleError,
    { refreshInterval: 5 * 60_000 }
  );
  const [expanded, setExpanded] = useState(false);
  const level = configuredLevel(allowlist, repoFullName);
  const policy = levelPolicyPresentation(level);

  if (!promotion.loaded || !demotion.loaded || !tenure.loaded) {
    return <Skeleton variant="rectangular" height={80} />;
  }

  const promotionRows =
    policy.primaryCriteria === "promotion"
      ? buildCriteriaRows(promotion.summary, tenure.tenure)
      : buildOperationalBaselineRows(promotion.summary);
  const demotionRows = buildDemotionRows(demotion.summary);
  const rows = mergeCriteriaRows(promotionRows, demotionRows);
  const l3ProtectionStatus = getL3ProtectionStatus(
    level,
    demotionRows,
    demotion.summary !== null,
    demotion.error
  );

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
            <Typography variant="h6">{policy.title}</Typography>
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
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            flexWrap="wrap"
            useFlexGap
          >
            <Chip
              label={policy.configuredStatus}
              size="small"
              color="info"
              variant="outlined"
            />
            {policy.showProtectionStatus && l3ProtectionStatus && (
              <Chip
                label={
                  l3ProtectionStatus === "active"
                    ? "Temporary protection active"
                    : l3ProtectionStatus === "clear"
                    ? "Protection clear"
                    : "Protection status unavailable"
                }
                size="small"
                color={
                  l3ProtectionStatus === "active"
                    ? "error"
                    : l3ProtectionStatus === "clear"
                    ? "success"
                    : "warning"
                }
                variant="outlined"
              />
            )}
            {policy.primarySummaryLabel && (
              <L3SummaryChip
                label={policy.primarySummaryLabel}
                rows={promotionRows}
                variant="promotion"
              />
            )}
            {policy.secondarySummaryLabel && (
              <L3SummaryChip
                label={policy.secondarySummaryLabel}
                rows={demotionRows}
                variant="demotion"
              />
            )}
            {level === "L2" && (
              <Chip
                label="Demotion policy begins at L3"
                size="small"
                variant="outlined"
              />
            )}
          </Stack>
        </Box>

        <Collapse in={expanded} timeout="auto" unmountOnExit>
          <Stack spacing={1.5}>
            <Typography variant="caption" color="text.secondary">
              {policy.description} Configured-level decisions and their recorded
              evidence are available in{" "}
              <Link href="#configured-level-history">
                Configured-Level History
              </Link>
              .
            </Typography>

            {policy.showCriteria && (
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
                        <strong>{policy.primaryLabel}</strong>
                      </TableCell>
                      {policy.showSecondaryColumn && (
                        <TableCell align="right">
                          <strong>{policy.secondaryLabel}</strong>
                        </TableCell>
                      )}
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
                        {policy.showSecondaryColumn && (
                          <TableCell align="right">
                            {policy.showDemotionSignals ? (
                              <VerdictValue
                                row={r.demotion}
                                variant="demotion"
                              />
                            ) : (
                              <Typography variant="body2" color="text.disabled">
                                not applicable
                              </Typography>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Stack>
        </Collapse>
      </Stack>
    </Paper>
  );
}
