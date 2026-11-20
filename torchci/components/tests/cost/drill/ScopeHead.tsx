import { Box, Typography, useTheme } from "@mui/material";
import { VISUALLY_HIDDEN } from "components/tests/cost/rates/RateStrip";
import FactPill from "components/tests/FactPill";
import {
  amount,
  arrowText,
  changeText,
  deltaText,
  perWord,
  testHoursText,
} from "lib/tests/cost/drill";
import { shareLabel } from "lib/tests/cost/query";
import { drillColors, toneOf } from "./ButterflyRow";
import { drillKeys } from "./ScopeTrail";
import type { DrillModel } from "./useDrill";

export interface ScopeHeadProps {
  drill: DrillModel;
}

// The A/B summary that follows the trail: the scope's title in
// its ancestors, fact pills (B with its change, A, the other per, pushes to
// main at the root or the share of the parent, test time at a file), the
// data chips, and the change sentence. The page's own facts (a year, owners,
// the PR signals) sit under its title, being neither A/B nor the scope's. A
// previewed sibling draws here with a dashed outline.
export default function ScopeHead({ drill }: ScopeHeadProps) {
  const theme = useTheme();
  const c = drillColors(theme);
  const { head } = drill;
  const { unit, per } = drill.input;
  const row = head.scope;
  const stale = head.stale || row === null;
  const tone = toneOf(row?.delta ?? null);
  const toneColor =
    tone === "up" ? c.upText : tone === "down" ? c.down : "text.secondary";
  const dots = "…";
  // null is a side without days, or in $ a side whose days have no rates
  // (blank, never $0): the row says which.
  const v = (side: "A" | "B", x: number | null, approx = false) =>
    stale
      ? dots
      : x === null
      ? (side === "A" ? row?.blankA : row?.blankB) ?? "no data"
      : `${approx ? "≈" : ""}${amount(unit, x)}`;
  const otherPer = per === "day" ? "commit" : "day";
  return (
    <Box
      onKeyDown={drillKeys(drill)}
      sx={{
        py: 1,
        px: head.previewing ? 1 : 0,
        mx: head.previewing ? -1 : 0,
        borderRadius: 1,
        outline: head.previewing
          ? `1px dashed ${theme.palette.primary.main}`
          : undefined,
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "baseline",
          gap: 1,
          flexWrap: "wrap",
        }}
      >
        <Typography
          component="h3"
          variant="h6"
          sx={{ fontSize: "1.15rem", fontWeight: 600, lineHeight: 1.3 }}
        >
          {head.title}
        </Typography>
        {head.context && (
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {head.context}
          </Typography>
        )}
        {head.previewing && (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            Previewing {head.previewing} · click to switch, Esc to cancel
          </Typography>
        )}
      </Box>
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          gap: 1,
          mt: 0.75,
          alignItems: "center",
        }}
      >
        <FactPill label={`B ${perWord(per).replace("a ", "per ")}`}>
          <Box component="span" sx={{ display: "inline-flex", gap: 0.75 }}>
            <span>{v("B", row?.b ?? null, row?.approxB)}</span>
            {!stale && row?.delta != null && (
              <Box component="span" sx={{ color: toneColor, fontWeight: 400 }}>
                {deltaText(unit, row.delta)} {changeText(row)}
              </Box>
            )}
          </Box>
        </FactPill>
        <FactPill
          label={`A ${perWord(per).replace("a ", "per ")}`}
          muted={!stale && row?.a === null}
        >
          {v("A", row?.a ?? null, row?.approxA)}
        </FactPill>
        <FactPill label={otherPer === "commit" ? "Per commit" : "Per day"}>
          {stale
            ? dots
            : per === "day" && row?.notOnMain
            ? "not on main"
            : arrowText(unit, row?.other.a ?? null, row?.other.b ?? null)}
        </FactPill>
        {head.root && head.pushes && (
          <FactPill label="Pushes to main">
            {head.pushes.a === null ? "–" : head.pushes.a.toFixed(0)} →{" "}
            {head.pushes.b === null ? "–" : head.pushes.b.toFixed(0)} a day
          </FactPill>
        )}
        {!head.root && (
          <FactPill label={`Share of ${head.parentName}`}>
            {stale || head.share === null ? dots : shareLabel(head.share)}
          </FactPill>
        )}
        {head.fileLevel && row?.tests && (
          <FactPill label="Test time a day">
            {stale
              ? dots
              : `${testHoursText(row.tests.a)} → ${testHoursText(row.tests.b)}`}
          </FactPill>
        )}
        {/* The pickers above say how many days are priced; the chips stay
            in the model for the trail's titles. */}
        {head.chips
          .filter((chip) => !chip.endsWith("days priced"))
          .map((chip) => (
            <Box
              key={chip}
              component="span"
              sx={{
                typography: "caption",
                color: "text.secondary",
                border: `1px solid ${theme.palette.divider}`,
                borderRadius: "999px",
                px: 1,
                py: 0.25,
              }}
            >
              {chip}
            </Box>
          ))}
      </Box>
      {/* The change in words, for screen readers only: on screen the chips
          and the table say it, and what it means is the reader's call. */}
      <Typography variant="body2" sx={VISUALLY_HIDDEN}>
        {head.sentence?.map((p, i) => (
          <Box
            key={i}
            component="span"
            sx={{
              fontWeight: p.strong ? 600 : undefined,
              color:
                p.tone === "up"
                  ? c.upText
                  : p.tone === "down"
                  ? c.down
                  : undefined,
            }}
          >
            {p.text}
          </Box>
        ))}
      </Typography>
    </Box>
  );
}
