import { Box, Typography, useTheme } from "@mui/material";
import ChangesMachines from "components/tests/cost/ChangesMachines";
import KeyButton from "components/tests/cost/KeyButton";
import LoadError from "components/tests/LoadError";
import type { CostChanges } from "lib/api/tests/cost/types";
import { changeSummary, changeWord } from "lib/tests/cost/changes";
import { fineAmountLabel, shareLabel } from "lib/tests/cost/query";
import type { RatesFile } from "lib/tests/cost/rates";
import {
  joinNames,
  ownerLabel,
  type PreparedHours,
} from "lib/tests/cost/runnerHours";
import { daysLabel, type TrendPer } from "lib/tests/cost/trend";

export interface TrendChangesProps {
  // The answer for the periods and owners compared; the one shown last while
  // the next loads.
  changes: CostChanges | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  // The rates file when the panel shows $, null in runner-hours.
  rates: RatesFile | null;
  // Per day with data, or per commit (push:main over pushes to main), as
  // the panel compares; its keys here switch the panel's.
  per: TrendPer;
  onPerChange: (_per: TrendPer) => void;
  // The cost answer, for the machines and their hues.
  prepared?: PreparedHours;
}

const signed = (unit: "hours" | "cost", v: number) =>
  `${v > 0 ? "▲ +" : v < 0 ? "▼ −" : ""}${fineAmountLabel(unit, Math.abs(v))}`;

// What changed between the trend's two periods, for the highlighted owners
// or every owner, per day with data or per commit: the whole change, in $
// split into more runner-hours and pricier machines, the pushes to main and
// what each cost, then the change by machine and runner label.
export default function TrendChanges({
  changes,
  loading,
  error,
  onRetry,
  rates,
  per,
  onPerChange,
  prepared,
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
  const whose =
    changes === undefined || changes.owners.length === 0
      ? "every owner"
      : joinNames(changes.owners.map(ownerLabel));

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
        What changed · {whose} · per {per} · A → B
      </Typography>
      <KeyButton
        title="Each machine per day with data: every trigger's runner time"
        active={per === "day"}
        onClick={() => onPerChange("day")}
      >
        Per day
      </KeyButton>
      <KeyButton
        title={
          noPushes
            ? "No pushes to main in A or B"
            : "Each machine per commit: what a push to main costs, its jobs' runner time over the pushes to main"
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

  // The answer's own periods, which lag the panel's while the next loads.
  const aLabel = daysLabel(changes.a);
  const bLabel = daysLabel(changes.b);
  const color = (delta: number) =>
    delta === 0 ? "text.secondary" : delta > 0 ? up : down;
  const push = summary.push;
  const a = per === "day" ? "a day" : "a commit";

  return (
    <Box sx={{ opacity: loading ? 0.6 : 1, transition: "opacity 120ms" }}>
      {heading}
      <Typography variant="body2" component="p">
        {amount(summary.aPer)} {a} in A ({aLabel}), {amount(summary.bPer)} in B
        ({bLabel}):{" "}
        <Box component="b" sx={{ color: color(summary.delta) }}>
          {signed(unit, summary.delta)} {a}
          {summary.change === null
            ? ""
            : ` (${changeWord(summary).replace(/^[▲▼] /, "")})`}
        </Box>
        {summary.volume !== null && summary.mix !== null && (
          <>
            {" "}
            = {signed(unit, summary.volume)} from{" "}
            {summary.volume >= 0 ? "more" : "fewer"} runner-hours
            {Math.abs(summary.mix) < (unit === "cost" ? 0.005 : 0.05)
              ? " on the same mix of machines"
              : `, ${signed(unit, summary.mix)} from ${
                  summary.mix >= 0 ? "pricier" : "cheaper"
                } machines`}
          </>
        )}
        .
      </Typography>
      {push !== null && (
        <Typography
          variant="body2"
          component="p"
          sx={{ color: "text.secondary" }}
        >
          Pushes to main: {push.aPushesPerDay.toFixed(0)} a day in A,{" "}
          {push.bPushesPerDay.toFixed(0)} in B
          {per === "day" &&
            push.aPerPush !== null &&
            push.bPerPush !== null && (
              <>
                {" "}
                · {amount(push.aPerPush)} a commit → {amount(push.bPerPush)}
                {push.change !== null &&
                  ` (${push.change >= 0 ? "+" : "−"}${shareLabel(
                    Math.abs(push.change)
                  )})`}
              </>
            )}
          .{" "}
          {per === "commit"
            ? "Per commit is what a push to main costs: main runs every test, with no target determination, so it is a normalized unit cost. A push lands a commit, or a stack, and runs CI on its head once."
            : "A push lands a commit, or a stack, and runs CI on its head once."}
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
        Bars: B; the tick: A. Click a machine to list its runners.
        {per === "day" &&
          ` Per day with data: ${summary.aDays} in A, ${summary.bDays} in B.`}
      </Typography>
      {per === "commit" && (
        <Typography
          variant="caption"
          component="p"
          sx={{ color: "warning.main" }}
        >
          ⚠ Pushes to main only: machines they do not run on drop out, and
          shares are of a main push&apos;s cost.
        </Typography>
      )}
    </Box>
  );
}
