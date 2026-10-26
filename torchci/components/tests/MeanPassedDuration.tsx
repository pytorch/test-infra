import { Box } from "@mui/material";
import { CellLines } from "components/tests/CellBlock";
import { durationLabel, integerLabel, passedRunsLabel } from "lib/tests/table";

export interface MeanPassedDurationProps {
  // The mean duration of the passed runs in milliseconds; null when no run
  // passed, so there is no mean.
  milliseconds: number | null;
  // How many passed runs the mean is over.
  passedRuns: number;
}

// A mean duration in a readable unit, "625 ms" or "12.7 s", over the number
// of passed runs it averages in smaller muted text: the Health cell's two
// lines (`CellLines`), without its frame. A muted dash stands in for the
// mean when nothing passed; the count beneath it then says why. The tooltip
// gives the mean to the millisecond.
export default function MeanPassedDuration({
  milliseconds,
  passedRuns,
}: MeanPassedDurationProps) {
  return (
    <CellLines
      title={
        milliseconds === null ? undefined : `${integerLabel(milliseconds)} ms`
      }
      lead={
        milliseconds === null ? (
          <Box component="span" sx={{ color: "text.secondary" }}>
            —
          </Box>
        ) : (
          durationLabel(milliseconds)
        )
      }
      caption={passedRunsLabel(passedRuns)}
    />
  );
}
