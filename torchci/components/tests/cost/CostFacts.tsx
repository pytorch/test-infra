import {
  Box,
  ButtonBase,
  MenuItem,
  Select,
  Skeleton,
  Tooltip,
  useTheme,
} from "@mui/material";
import FactPill from "components/tests/FactPill";
import { VIEW_CHIP_HEIGHT } from "components/tests/ViewChips";
import type { CostSignal } from "lib/api/tests/cost/types";
import {
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
  // The days the answer covers, in words.
  dates: string;
  // The window asked for; the answer shown is the last one while it loads.
  window: CostWindow;
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
// The time range's dropdown sits at the row's right end, out of the way.
export default function CostFacts({
  facts,
  dates,
  window,
  loading,
  onWindowChange,
  scope,
  signals,
  onClearScope,
}: CostFactsProps) {
  const theme = useTheme();
  const windowPicker = (
    <Select
      size="small"
      value={window}
      onChange={(event) => onWindowChange(event.target.value as CostWindow)}
      inputProps={{ "aria-label": "Time range" }}
      sx={{ ml: "auto", height: VIEW_CHIP_HEIGHT + 4, typography: "body2" }}
    >
      {COST_WINDOWS.map((w) => (
        <MenuItem key={w} value={w} sx={{ typography: "body2" }}>
          Last {COST_WINDOW_LABELS[w]}
        </MenuItem>
      ))}
    </Select>
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
        {windowPicker}
      </Box>
    );
  }
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
          `${hoursLabel(
            facts.scopeTotal
          )} h${where}, ${dates}, scaled to a year`,
          `${hoursLabel(facts.annualized)} runner-hours a year`
        )}
        {pill(
          "Per day",
          `Daily average over ${dates}`,
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
                : `p90 ${signalLabel(signal.p90_seconds)} · ${
                    signal.runs
                  } runs`,
            ]
              .filter(Boolean)
              .join("\n"),
            signal.p50_seconds === null
              ? "none"
              : signalLabel(signal.p50_seconds)
          )
        )}
      </Box>
      {windowPicker}
    </Box>
  );
}
