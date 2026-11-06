import { Box, Typography, useTheme } from "@mui/material";
import ChangesMachines from "components/tests/cost/ChangesMachines";
import KeyButton from "components/tests/cost/KeyButton";
import LoadError from "components/tests/LoadError";
import type { CostChanges } from "lib/api/tests/cost/types";
import { changeSummary, changeWord } from "lib/tests/cost/changes";
import { fineAmountLabel } from "lib/tests/cost/query";
import type { RatesFile } from "lib/tests/cost/rates";
import {
  joinNames,
  ownerLabel,
  type PreparedHours,
} from "lib/tests/cost/runnerHours";
import {
  changeLabel,
  daysLabel,
  deltaLabel,
  type TrendPer,
} from "lib/tests/cost/trend";

export interface TrendChangesProps {
  // The answer for the periods and owners compared; the one shown last while
  // the next loads.
  changes: CostChanges | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  // The rates file when the panel shows $, null in runner-hours.
  rates: RatesFile | null;
  // The page's highlighted owners, in the order the rest of the panel names
  // them; the answer's own owners are sorted.
  highlighted?: readonly string[];
  // Per day with data, or per commit (push:main over pushes to main), as
  // the panel compares; its keys here switch the panel's.
  per: TrendPer;
  onPerChange: (_per: TrendPer) => void;
  // The cost answer, for the machines and their hues.
  prepared?: PreparedHours;
}

const signed = (unit: "hours" | "cost", v: number) =>
  v === 0
    ? fineAmountLabel(unit, 0)
    : deltaLabel(v, (x) => fineAmountLabel(unit, x));

// What changed between the trend's two periods, for the highlighted owners
// or every owner, per day with data or per commit: in $, the change split
// into more runner-hours and pricier machines (in runner-hours, the table's
// first row says it all), the pushes to main and what each cost, then the
// change by machine and runner label. The heading names the periods the
// answer is for.
export default function TrendChanges({
  changes,
  loading,
  error,
  onRetry,
  rates,
  per,
  onPerChange,
  prepared,
  highlighted = [],
}: TrendChangesProps) {
  const theme = useTheme();
  const unit = rates === null ? "hours" : "cost";
  const amount = (v: number) => fineAmountLabel(unit, v);
  const up = theme.palette.error.main;
  const down =
    theme.palette.mode === "dark"
      ? theme.palette.success.light
      : theme.palette.success.dark;
  const summary =
    changes === undefined ? null : changeSummary(changes, rates, per);
  const noPushes = summary !== null && summary.push === null;
  const rank = (o: string) => {
    const i = highlighted.indexOf(o);
    return i < 0 ? Infinity : i;
  };
  const whose =
    changes === undefined || changes.owners.length === 0
      ? "all owners"
      : joinNames(
          [...changes.owners].sort((x, y) => rank(x) - rank(y)).map(ownerLabel)
        );
  // The answer's own periods, which lag the panel's while the next loads.
  const aLabel = changes === undefined ? "" : daysLabel(changes.a);
  const bLabel = changes === undefined ? "" : daysLabel(changes.b);

  const heading = (
    <Box
      sx={{ display: "flex", alignItems: "center", gap: 0.75, mt: 2, mb: 0.5 }}
    >
      <Typography
        component="h3"
        sx={{
          fontSize: "0.75rem",
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "text.secondary",
          mr: "auto",
        }}
      >
        What changed · {whose} · per {per} ·{" "}
        {changes === undefined ? "A → B" : `A ${aLabel} → B ${bLabel}`}
      </Typography>
      <KeyButton
        title="Each machine per day: all runs, averaged over days with data"
        active={per === "day"}
        onClick={() => onPerChange("day")}
      >
        Per day
      </KeyButton>
      <KeyButton
        title={
          noPushes
            ? "No pushes to main in A or B"
            : "Each machine's part of what one push to main costs"
        }
        active={per === "commit"}
        disabled={noPushes}
        onClick={() => onPerChange("commit")}
      >
        Per commit
      </KeyButton>
    </Box>
  );
  if (error !== undefined && changes === undefined) {
    return (
      <>
        {heading}
        <LoadError what="what changed" error={error} onRetry={onRetry} />
      </>
    );
  }
  if (changes === undefined || summary === null) {
    return (
      <>
        {heading}
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          Comparing A and B…
        </Typography>
      </>
    );
  }

  const color = (delta: number) =>
    delta === 0 ? "text.secondary" : delta > 0 ? up : down;
  const push = summary.push;
  const a = per === "day" ? "a day" : "a commit";

  return (
    <Box sx={{ opacity: loading ? 0.6 : 1, transition: "opacity 120ms" }}>
      {heading}
      {unit === "cost" &&
        summary.volume !== null &&
        summary.mix !== null &&
        summary.delta !== 0 && (
          <Typography variant="body2" component="p">
            <Box component="b" sx={{ color: color(summary.delta) }}>
              {signed(unit, summary.delta)} {a}
              {summary.change === null
                ? ""
                : ` (${changeWord(summary).replace(/^[▲▼] /, "")})`}
            </Box>
            {Math.abs(summary.mix) < 0.005
              ? `, all from ${
                  summary.volume >= 0 ? "more" : "fewer"
                } runner-hours on the same machine mix.`
              : `: ${signed(unit, summary.volume)} from ${
                  summary.volume >= 0 ? "more" : "fewer"
                } runner-hours, ${signed(unit, summary.mix)} from ${
                  summary.mix >= 0 ? "pricier" : "cheaper"
                } machines.`}
          </Typography>
        )}
      {push !== null && (
        <Typography
          variant="body2"
          component="p"
          sx={{ color: "text.secondary" }}
        >
          Pushes to main: {push.aPushesPerDay.toFixed(0)} a day in A,{" "}
          {push.bPushesPerDay.toFixed(0)} in B
          {per === "commit"
            ? ". Per commit is what one push to main costs, with every test running (no target determination), so only the machines main runs on appear."
            : push.aPerPush !== null && push.bPerPush !== null
            ? ` · ${amount(push.aPerPush)} → ${amount(
                push.bPerPush
              )} per commit${
                push.change === null || push.change === 0
                  ? ""
                  : ` (${changeLabel({
                      change: push.change,
                      delta: push.change,
                    }).replace(/^[▲▼] /, "")})`
              }.`
            : "."}
        </Typography>
      )}
      <Box sx={{ mt: 1 }}>
        <ChangesMachines
          changes={changes}
          rates={rates}
          per={per}
          prepared={prepared}
          aLabel={aLabel}
          bLabel={bLabel}
        />
      </Box>
      <Typography
        variant="caption"
        component="p"
        sx={{ color: "text.secondary" }}
      >
        Bars show B; ticks mark A. Click a machine to list its runners.
      </Typography>
    </Box>
  );
}
