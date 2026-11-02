import { Box } from "@mui/material";
import type { Theme } from "@mui/material/styles";
import type { RunOutcome } from "lib/api/tests/test/runs/types";
import { attemptStatus, OUTCOME_WORDS } from "lib/tests/grid";
import { attemptPillColors } from "lib/tests/gridColors";
import { Fragment, ReactNode } from "react";

export interface AttemptPillProps {
  outcome: RunOutcome;
  theme: Theme;
  // The pill's words; the outcome's own word, "Passed", unless given, as
  // when one pill stands for several attempts, "Failed ×9".
  children?: ReactNode;
}

// One attempt as a pill: the word of its outcome in its status's colors
// (attemptPillColors), the health blocks' pale background with the ink that
// reads on it.
export function AttemptPill({ outcome, theme, children }: AttemptPillProps) {
  const colors = attemptPillColors(theme, attemptStatus(outcome));
  return (
    <Box
      component="span"
      sx={{
        px: 0.75,
        borderRadius: 999,
        backgroundColor: colors.background,
        color: colors.text,
        fontWeight: 500,
        lineHeight: 1.6,
      }}
    >
      {children ?? OUTCOME_WORDS[outcome]}
    </Box>
  );
}

// A run's attempts as a row of pills, an arrow from one to the next:
// "Crashed → Passed".
export default function AttemptPills({
  attempts,
  theme,
}: {
  attempts: readonly RunOutcome[];
  theme: Theme;
}) {
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 0.5,
      }}
    >
      {attempts.map((outcome, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <Box component="span" sx={{ color: "text.disabled" }}>
              →
            </Box>
          )}
          <AttemptPill outcome={outcome} theme={theme} />
        </Fragment>
      ))}
    </Box>
  );
}
