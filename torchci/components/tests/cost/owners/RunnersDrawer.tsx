import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { Box, Drawer, IconButton, Typography, useTheme } from "@mui/material";
import { costUnit } from "lib/api/tests/cost/contracts";
import { barFill, runnerFill } from "lib/tests/cost/colors";
import {
  noRateRunners,
  type OwnerBarsModel,
  type OwnerRow,
  paintOf,
  partlyUnpriced,
  rateText,
  rowMix,
  runnerBreakdown,
  type RunnerFigures,
  segments,
} from "lib/tests/cost/ownerBars";
import {
  amountLabel,
  hoursLabel,
  shareLabel,
  UNIT_NAMES,
} from "lib/tests/cost/query";
import { type KeyboardEvent, useEffect, useRef } from "react";

const WIDTH = 600;
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
// How many runners without a rate the note names.
const NAMED = 5;

export interface RunnersDrawerProps {
  model: OwnerBarsModel;
  // The row whose › is open: an owner, the owners folded together, the
  // unattributed hours or one of their buckets.
  row: OwnerRow | null;
  scopeLabel: string;
  onClose: () => void;
}

// What one owner bar row ran on, at the page's right edge (V1's): its
// machines largest first, each with its share of the row, and under each its
// runners (the runner labels a rates file prices) with their share of the
// machine. In $ each has its $/h over B (day by day; ~ on a machine's, and
// on a runner's whose rate changed) and $, the hours without a rate counted, and a note names
// the row's runners with no rate on any priced day. The machines add up to
// the row, the runners to their machine. Esc or × closes it.
export default function RunnersDrawer({
  model,
  row,
  scopeLabel,
  onClose,
}: RunnersDrawerProps) {
  const theme = useTheme();
  const { prepared, view } = model;
  const dollars = model.unit === "usd";
  const unit = costUnit(model.unit);
  const amount = (v: number) => amountLabel(unit, v);
  const hoursText = (v: number) => amountLabel("hours", v);
  const close = useRef<HTMLButtonElement>(null);
  // Focus moves to × on opening and back to the › on closing.
  const back = useRef<HTMLElement | null>(null);
  const open = row !== null;
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    back.current = document.activeElement as HTMLElement | null;
    close.current?.focus();
  }, [open]);
  const shut = () => {
    onClose();
    back.current?.focus?.();
  };

  // Mounted only while open: no slide-out, and nothing listening meanwhile.
  if (row === null) return null;
  const machines = runnerBreakdown(model, row.owners);
  const hours = machines.reduce((a, m) => a + m.hours, 0);
  const unpriced = machines.reduce((a, m) => a + m.unpriced, 0);
  const missing = dollars ? noRateRunners(model, row.owners) : null;
  const partly =
    dollars &&
    machines.some((m) => partlyUnpriced(m) || m.runners.some(partlyUnpriced));
  const mix = rowMix(prepared, view, row.owners);
  const estimated = rowMix(prepared, view, row.owners, true);
  const share = (x: number, of: number, fill: string) => (
    <Box
      component="td"
      sx={{ width: 96, color: "text.secondary", whiteSpace: "nowrap" }}
    >
      {of > 0 ? (
        <>
          <Box
            component="span"
            sx={{
              display: "inline-block",
              // A pixel at least; a bare 1 would read as 100% in sx.
              width: `${Math.max(1, Math.round((x / of) * 40))}px`,
              height: 6,
              mr: 0.75,
              verticalAlign: "middle",
              borderRadius: "1px",
              background: fill,
            }}
          />
          {shareLabel(x / of)}
        </>
      ) : (
        "—"
      )}
    </Box>
  );
  // The figures after a name: hours, the unpriced ones, $/h, $, share.
  const cells = (f: RunnerFigures, of: number, fill: string) => {
    const none = dollars && f.rate === null;
    return (
      <>
        <td>{hoursText(f.hours)}</td>
        {partly && (
          <Box component="td" sx={{ color: "text.secondary" }}>
            {partlyUnpriced(f) ? hoursText(f.unpriced) : ""}
          </Box>
        )}
        {dollars && (
          <Box
            component="td"
            sx={{
              color: "text.secondary",
              fontStyle: none ? "italic" : undefined,
            }}
            title={
              f.approx
                ? "An average: $ over priced runner-hours, over B's days and runners"
                : undefined
            }
          >
            {rateText(f)}
          </Box>
        )}
        {dollars && <td>{none ? "—" : amount(f.value)}</td>}
        {none ? (
          <Box component="td" sx={{ color: "text.secondary" }}>
            —
          </Box>
        ) : (
          share(f.value, of, fill)
        )}
      </>
    );
  };
  return (
    <Drawer
      anchor="right"
      variant="persistent"
      open
      slotProps={{
        paper: {
          role: "complementary",
          "aria-label": `Machines and runners of ${row.label}`,
          onKeyDown: (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            shut();
          },
          sx: {
            width: WIDTH,
            maxWidth: "100vw",
            p: 2.5,
            boxShadow: theme.shadows[8],
            borderLeft: `1px solid ${theme.palette.divider}`,
          },
        },
      }}
    >
      <IconButton
        ref={close}
        aria-label="Close (Esc)"
        onClick={shut}
        size="small"
        sx={{ position: "absolute", top: 12, right: 12 }}
      >
        <CloseRoundedIcon fontSize="small" />
      </IconButton>
      <>
        <Typography
          variant="caption"
          sx={{
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "text.secondary",
          }}
        >
          {row.kind === "owner"
            ? "Owner"
            : row.kind === "more"
            ? "Owners outside the top"
            : "Unattributed"}
        </Typography>
        <Typography variant="h6" component="h3" sx={{ pr: 4, lineHeight: 1.3 }}>
          {row.label}
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {amount(row.hours)} · {shareLabel(row.hours / (view.scopeTotal || 1))}{" "}
          of {amount(view.scopeTotal)}
          {dollars
            ? ` · ${hoursLabel(hours)} runner-hours${
                unpriced >= 0.5 ? `, ${hoursLabel(unpriced)} h unpriced` : ""
              }`
            : ""}{" "}
          · in {scopeLabel}
        </Typography>
        <Box sx={{ display: "flex", gap: "1px", height: 14, my: 1.25 }}>
          {segments(prepared, mix, new Set(), estimated)
            .filter((s) => s.hours > 0)
            .map((s) => (
              <Box
                key={s.key}
                title={`${s.label}: ${amount(s.hours)}`}
                sx={{
                  flex: `${s.hours} 0 0`,
                  minWidth: "1px",
                  borderRadius: "2px",
                  background: barFill(theme, prepared, s.paint),
                }}
              />
            ))}
        </Box>
        <Typography
          variant="caption"
          component="p"
          sx={{ color: "text.secondary" }}
        >
          Machines: share of {row.label}&apos;s {UNIT_NAMES[unit]}. Runners:
          share of their machine&apos;s.
          {dollars &&
            " ~: an average, every machine's and a runner's whose rate changed over B."}
        </Typography>
        <Box
          component="table"
          sx={{
            width: "100%",
            borderCollapse: "collapse",
            mt: 1.25,
            typography: "body2",
            fontVariantNumeric: "tabular-nums",
            "& th": {
              textAlign: "right",
              fontWeight: 500,
              color: "text.secondary",
              borderBottom: `1px solid ${theme.palette.divider}`,
              px: 0.75,
              py: 0.5,
              whiteSpace: "nowrap",
            },
            "& td": {
              textAlign: "right",
              px: 0.75,
              py: 0.375,
              verticalAlign: "top",
              whiteSpace: "nowrap",
            },
            "& th:first-of-type, & td:first-of-type": { textAlign: "left" },
            "& tr.machine td": {
              pt: 1.25,
              fontWeight: 500,
              borderTop: `1px solid ${theme.palette.divider}`,
            },
            "& tr.machine:first-of-type td": { borderTop: 0 },
          }}
        >
          <thead>
            <tr>
              <th>Machine · runner</th>
              <th>Runner-hours</th>
              {partly && <th>Unpriced</th>}
              {dollars && <th>$/h</th>}
              {dollars && <th>$</th>}
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            {machines.flatMap((m) => {
              const paint = paintOf(prepared, m.machine);
              const fill = barFill(theme, prepared, paint);
              const name = prepared.machines[m.machine];
              const order = model.runnerOrder[m.machine] ?? [];
              return [
                <tr key={name} className="machine">
                  <td>
                    <Box
                      component="span"
                      sx={{
                        display: "inline-block",
                        width: 10,
                        height: 10,
                        mr: 0.875,
                        borderRadius: "50%",
                        verticalAlign: "-1px",
                        background: fill,
                      }}
                    />
                    {name}
                    {estimated[m.machine] > 0 && (
                      <Box
                        component="span"
                        sx={{ color: "text.secondary", fontWeight: 400 }}
                        title="Part of these hours have a machine estimated from their runner label"
                      >
                        {" "}
                        ·{" "}
                        {shareLabel(
                          estimated[m.machine] / (mix[m.machine] || 1)
                        )}{" "}
                        est.
                      </Box>
                    )}
                  </td>
                  {cells(m, row.hours, fill)}
                </tr>,
                ...m.runners.map((r) => (
                  <tr key={`${name}|${r.label}`}>
                    <Box
                      component="td"
                      sx={{
                        pl: "26px !important",
                        whiteSpace: "normal !important",
                        wordBreak: "break-all",
                        fontFamily: MONO,
                        fontSize: "0.75rem",
                      }}
                    >
                      {r.label}
                    </Box>
                    {cells(
                      r,
                      m.value,
                      runnerFill(theme, prepared, paint, order.indexOf(r.label))
                    )}
                  </tr>
                )),
              ];
            })}
          </tbody>
        </Box>
        {missing !== null && missing.runners.length > 0 && (
          <Typography
            variant="body2"
            component="p"
            sx={{
              mt: 1.5,
              pt: 1,
              borderTop: `1px solid ${theme.palette.divider}`,
              color: "text.secondary",
            }}
          >
            No rate: {missing.runners.length}{" "}
            {missing.runners.length === 1 ? "runner" : "runners"},{" "}
            {hoursLabel(missing.hours)} h (
            {shareLabel(missing.hours / (missing.of || 1))} of {row.label}
            &apos;s runner-hours
            {model.divisors.pricedNote !== null ? " on priced days" : ""}):{" "}
            {missing.runners
              .slice(0, NAMED)
              .map((r) => `${r.label} (${hoursLabel(r.hours)} h)`)
              .join(", ")}
            {missing.runners.length > NAMED
              ? `, and ${missing.runners.length - NAMED} more`
              : ""}
            .
          </Typography>
        )}
      </>
    </Drawer>
  );
}
