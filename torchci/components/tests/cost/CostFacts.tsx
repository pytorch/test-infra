import {
  Box,
  ButtonBase,
  Skeleton,
  Tooltip,
  useTheme,
} from "@mui/material";
import KeyButton from "components/tests/cost/KeyButton";
import FactPill from "components/tests/FactPill";
import { VIEW_CHIP_HEIGHT } from "components/tests/ViewChips";
import type { CostSignal } from "lib/api/tests/cost/types";
import {
  COST_WINDOW_DAYS,
  COST_WINDOW_LABELS,
  COST_WINDOWS,
  type CostWindow,
} from "lib/api/tests/cost/windows";
import { hoursLabel, shareLabel } from "lib/tests/cost/query";

// A duration as the facts say it: "4.0 h", "27 min".
export function signalLabel(seconds: number): string {
  return seconds >= 3600
    ? `${(seconds / 3600).toFixed(1)} h`
    : `${Math.round(seconds / 60)} min`;
}

export interface CostFactsProps {
  // undefined until the runner-hours arrive.
  facts:
    | {
        scopeTotal: number;
        scopeShare: number;
        perDay: number;
        annualized: number;
        attributedShare: number;
      }
    | undefined;
  // The days with data, and the window asked for.
  days: number;
  dates: string;
  window: CostWindow;
  // The window of the answer shown, the last one while a new one loads.
  answerWindow: CostWindow | undefined;
  loading: boolean;
  onWindowChange: (_window: CostWindow) => void;
  // The scope in words, null for every workflow.
  scope: string | null;
  // The PR update and merge signals, from the API.
  signals: CostSignal[] | undefined;
  onClearScope: () => void;
}

// The headline figures as the test page's facts: pills in the band's grey.
// The first says what the hours cover, in the accent with a clear button
// while a scope of workflows is in force; the next four follow the scope;
// the PR update and merge signals are their workflows' whatever is scoped.
// The window's keys sit at the row's right end, out of the way.
export default function CostFacts({
  facts,
  days,
  dates,
  window,
  answerWindow,
  loading,
  onWindowChange,
  scope,
  signals,
  onClearScope,
}: CostFactsProps) {
  const theme = useTheme();
  const windowKeys = (
    <Box sx={{ display: "flex", gap: 0.5, ml: "auto" }}>
      {COST_WINDOWS.map((w) => (
        <KeyButton
          key={w}
          title={`Last ${COST_WINDOW_LABELS[w]}, whole UTC days`}
          active={w === window}
          onClick={() => onWindowChange(w)}
        >
          {COST_WINDOW_LABELS[w]}
        </KeyButton>
      ))}
    </Box>
  );
  if (facts === undefined) {
    return (
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
        {[16, 22, 18, 18, 15, 22].map((width, i) => (
          <Skeleton
            key={i}
            variant="rounded"
            sx={{
              width: `${width}ch`,
              height: VIEW_CHIP_HEIGHT,
              borderRadius: "999px",
            }}
          />
        ))}
        {windowKeys}
      </Box>
    );
  }
  const asked = COST_WINDOW_DAYS[answerWindow ?? window];
  const where = scope === null ? "" : ` in ${scope}`;
  const pill = (label: string, title: string, value: string) => (
    <Tooltip
      key={label}
      title={title}
      enterDelay={300}
      slotProps={{ tooltip: { sx: { whiteSpace: "pre-line" } } }}
    >
      <span>
        <FactPill label={label}>{value}</FactPill>
      </span>
    </Tooltip>
  );
  return (
    <Box
      sx={{ display: "flex", flexWrap: "wrap", gap: 1, typography: "body2" }}
    >
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          gap: 1,
          opacity: loading ? 0.6 : 1,
          transition: "opacity 150ms",
        }}
      >
      {scope === null ? (
        pill("Across", "Every workflow's runner-hours", "all workflows")
      ) : (
        <Tooltip
          title="The page counts only these workflows' hours."
          enterDelay={300}
        >
          <Box
            component="span"
            sx={{
              display: "inline-flex",
              alignItems: "center",
              gap: 0.75,
              height: VIEW_CHIP_HEIGHT,
              pl: 1.25,
              pr: 0.5,
              borderRadius: "999px",
              color: "primary.main",
              boxShadow: `inset 0 0 0 1px ${theme.palette.primary.main}`,
              whiteSpace: "nowrap",
            }}
          >
            Across
            <Box component="span" sx={{ fontWeight: 500 }}>
              {scope}
            </Box>
            <span>· {shareLabel(facts.scopeShare)} of all runner-hours</span>
            <ButtonBase
              aria-label="Show all workflows"
              onClick={onClearScope}
              sx={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                color: "primary.main",
                "&:hover": { backgroundColor: "action.hover" },
                "&.Mui-focusVisible": {
                  outline: `2px solid ${theme.palette.primary.main}`,
                },
              }}
            >
              ✕
            </ButtonBase>
          </Box>
        </Tooltip>
      )}
      {pill(
        "Annualized",
        `${hoursLabel(facts.scopeTotal)} h${where}, ${dates}, scaled to a year`,
        `${hoursLabel(facts.annualized)} runner-hours a year`
      )}
      {pill(
        "Per day",
        `Daily average over ${dates}${
          days < asked ? ` (${days} of ${asked} days have data)` : ""
        }`,
        `${hoursLabel(facts.perDay)} runner-hours`
      )}
      {pill(
        "Attributed to owners",
        "Share of hours with an owner",
        shareLabel(facts.attributedShare)
      )}
      {(signals ?? []).map((signal) =>
        pill(
          signal.label,
          [
            `Median ${signal.workflow} run time on main, queue included`,
            signal.p90_seconds === null
              ? ""
              : `p90 ${signalLabel(signal.p90_seconds)} · ${signal.runs} runs`,
          ]
            .filter(Boolean)
            .join("\n"),
          signal.p50_seconds === null ? "none" : signalLabel(signal.p50_seconds)
        )
      )}
      </Box>
      {windowKeys}
    </Box>
  );
}
