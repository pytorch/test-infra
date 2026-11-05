import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { Box, Drawer, IconButton, Typography, useTheme } from "@mui/material";
import { paintFill } from "lib/tests/cost/colors";
import {
  amountLabel,
  hoursLabel,
  rateLabel,
  shareLabel,
  UNIT_NAMES,
} from "lib/tests/cost/query";
import { averageRate, missingRunners } from "lib/tests/cost/rates";
import {
  type CostView,
  type OwnerRow,
  paintOf,
  type PreparedHours,
  rowMix,
  runnerBreakdown,
  scopeName,
  segments,
} from "lib/tests/cost/runnerHours";

const WIDTH = 600;
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export interface RunnersDrawerProps {
  prepared: PreparedHours;
  view: CostView;
  // The chart row opened: an owner, the owners folded together, or the
  // unattributed hours.
  row: OwnerRow | null;
  // The rates file's name, in $.
  ratesFile: string | null;
  onClose: () => void;
}

// What one owner chart row ran on, at the page's right edge: its machines in
// the scope, largest first, each with its share of the row, and under each
// machine its runners (the runner labels a rates file prices) with their
// share of the machine. In $ every machine and runner has its $/h and
// cost, and a note names the row's runners the file has no rate for, so a
// reader knows what to add to the file.
export default function RunnersDrawer({
  prepared,
  view,
  row,
  ratesFile,
  onClose,
}: RunnersDrawerProps) {
  const theme = useTheme();
  const unit = prepared.unit;
  const dollars = unit === "cost";
  const amount = (value: number) => amountLabel(unit, value);
  let body = null;
  if (row !== null) {
    const machines = runnerBreakdown(prepared, view, row.owners);
    const value = machines.reduce((a, m) => a + m.value, 0);
    const hours = machines.reduce((a, m) => a + m.hours, 0);
    const unpriced = machines.reduce((a, m) => a + m.unpriced, 0);
    // In runner-hours no runner has a rate, and none is missing one.
    const missing = dollars ? missingRunners(machines) : [];
    const missingHours = missing.reduce((a, r) => a + r.hours, 0);
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
    body = (
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
          {dollars
            ? `${amount(value)} · ${shareLabel(
                value / (view.scopeTotal || 1)
              )} of the cost · ${hoursLabel(hours)} h${
                unpriced > 0.5
                  ? `, ${shareLabel(unpriced / (hours || 1))} with no rate`
                  : ""
              }`
            : `${hoursLabel(hours)} h · ${shareLabel(
                hours / (view.scopeTotal || 1)
              )} of all runner-hours`}{" "}
          · in {scopeName(prepared, view)}
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
                  background: paintFill(theme, prepared, s.paint),
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
              {dollars && <th>$/h</th>}
              {dollars && <th>Cost</th>}
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            {machines.flatMap((m) => {
              const fill = paintFill(
                theme,
                prepared,
                paintOf(prepared, m.machine)
              );
              const rate = averageRate(m.value, m.hours, m.unpriced);
              const rates = new Set(
                m.runners.filter((r) => r.rate !== null).map((r) => r.rate)
              );
              const name = prepared.machines[m.machine];
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
                  <td>{amountLabel("hours", m.hours)}</td>
                  {dollars && (
                    <Box
                      component="td"
                      sx={{ color: "text.secondary" }}
                      title={
                        rates.size > 1
                          ? "Its runners have different rates: the average over priced runner-hours"
                          : undefined
                      }
                    >
                      {rate !== null
                        ? `${rates.size > 1 ? "~" : ""}${rateLabel(rate)}`
                        : "—"}
                    </Box>
                  )}
                  {dollars && (
                    <td>{rate !== null ? amount(m.value) : "no rate"}</td>
                  )}
                  {dollars && rate === null ? (
                    <Box component="td" sx={{ color: "text.secondary" }}>
                      —
                    </Box>
                  ) : (
                    share(m.value, value, fill)
                  )}
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
                    <td>{amountLabel("hours", r.hours)}</td>
                    {dollars && (
                      <Box
                        component="td"
                        sx={{
                          color: "text.secondary",
                          fontStyle: r.rate === null ? "italic" : undefined,
                        }}
                      >
                        {r.rate === null ? "no rate" : rateLabel(r.rate)}
                      </Box>
                    )}
                    {dollars && (
                      <td>{r.rate === null ? "—" : amount(r.value)}</td>
                    )}
                    {dollars && r.rate === null ? (
                      <Box component="td" sx={{ color: "text.secondary" }}>
                        —
                      </Box>
                    ) : (
                      share(r.value, m.value, fill)
                    )}
                  </tr>
                )),
              ];
            })}
          </tbody>
        </Box>
        {missing.length > 0 && (
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
            No rate in {ratesFile}: {missing.length} of {row.label}&apos;s{" "}
            {missing.length === 1 ? "runner" : "runners"},{" "}
            {hoursLabel(missingHours)} h (
            {shareLabel(missingHours / (hours || 1))} of its runner-hours). Set
            their rates in the key.
          </Typography>
        )}
      </>
    );
  }
  return (
    <Drawer
      anchor="right"
      variant="persistent"
      open={row !== null}
      slotProps={{
        paper: {
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
        aria-label="Close (Esc)"
        onClick={onClose}
        size="small"
        sx={{ position: "absolute", top: 12, right: 12 }}
      >
        <CloseRoundedIcon fontSize="small" />
      </IconButton>
      {body}
    </Drawer>
  );
}
