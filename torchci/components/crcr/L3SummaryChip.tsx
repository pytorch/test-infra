import { Chip } from "@mui/material";
import { CriterionRow, summarizeReadiness } from "lib/crcr/l3Readiness";
import { useL3VerdictColors } from "lib/crcr/l3Thresholds";

// Shared by the per-repo CrcrL3Readiness panel and the /crcr at-a-glance
// readiness column so both summarize a repo's rows the same way.
export default function L3SummaryChip({
  label,
  rows,
  variant,
}: {
  label: string;
  rows: CriterionRow[];
  variant: "promotion" | "demotion";
}) {
  const { pass, fail } = useL3VerdictColors();
  const { judgedCount, metCount, totalCount, ready } = summarizeReadiness(rows);
  const triggeredCount = rows.filter((r) => r.verdict === false).length;

  // The chip's number is the *notable* count, matching the row coloring:
  // for Promotion that's how many criteria are met (want it to climb to
  // totalCount); for Demotion that's how many are currently triggering
  // (want it to stay at 0) — showing "met count" there instead would read
  // backwards, since a bigger number looks like more problems.
  const notableCount = variant === "promotion" ? metCount : triggeredCount;
  const suffix = variant === "promotion" ? "met" : "at risk";
  const notable = variant === "promotion" ? ready : triggeredCount > 0;
  const color = notable ? (variant === "promotion" ? pass : fail) : undefined;
  return (
    <Chip
      label={
        judgedCount === 0
          ? `${label}: no data`
          : `${label}: ${notableCount}/${totalCount} ${suffix}`
      }
      size="small"
      variant="outlined"
      sx={{ color, borderColor: color }}
    />
  );
}
