import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { Box, Drawer, IconButton, Typography, useTheme } from "@mui/material";
import { hoursLabel, shareLabel } from "lib/tests/cost/query";
import {
  cellDetail,
  type CostView,
  ownerLabel,
  type OwnerRow,
  type PreparedHours,
  scopeName,
} from "lib/tests/cost/runnerHours";

const WIDTH = 380;

// The opened cell, found in the current matrix: its row and machine index.
export interface OpenCell {
  row: OwnerRow;
  machine: number;
}

export interface CellDrawerProps {
  prepared: PreparedHours;
  view: CostView;
  cell: OpenCell | null;
  onClose: () => void;
}

function Heading({ children }: { children: string }) {
  return (
    <Typography
      component="h4"
      sx={{
        mt: 2.5,
        mb: 0.75,
        fontSize: "0.75rem",
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "text.secondary",
      }}
    >
      {children}
    </Typography>
  );
}

// One matrix cell's detail, at the page's right edge, the page usable
// beside it: its hours and what they are a share of, the workflows behind
// them in the scope, the owners of a folded row, and what the numbers can
// and cannot say. Where the API holds no detail yet (the test configs and
// files behind a cell, the label sampling), it says what it would need.
export default function CellDrawer({
  prepared,
  view,
  cell,
  onClose,
}: CellDrawerProps) {
  const theme = useTheme();
  const detail =
    cell === null
      ? null
      : cellDetail(prepared, view, cell.row.owners, cell.machine);
  const bars = (pairs: [string, number][], total: number) =>
    pairs.slice(0, 8).map(([name, hours]) => (
      <Box
        key={name}
        sx={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 80px 36px 56px",
          alignItems: "center",
          columnGap: 1,
          typography: "body2",
          minHeight: 24,
        }}
      >
        <Box
          component="span"
          sx={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={name}
        >
          {ownerLabel(name)}
        </Box>
        <Box
          component="span"
          sx={{
            height: 8,
            borderRadius: "2px",
            backgroundColor: "action.hover",
            position: "relative",
          }}
        >
          <Box
            component="span"
            sx={{
              position: "absolute",
              inset: 0,
              width: `${(100 * hours) / (total || 1)}%`,
              borderRadius: "2px",
              backgroundColor: theme.palette.primary.main,
            }}
          />
        </Box>
        <Box
          component="span"
          sx={{
            textAlign: "right",
            color: "text.secondary",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {shareLabel(hours / (total || 1))}
        </Box>
        <Box
          component="span"
          sx={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
        >
          {hoursLabel(hours)} h
        </Box>
      </Box>
    ));
  let body = null;
  if (cell !== null && detail !== null) {
    const m = cell.machine;
    const machine = prepared.machines[m];
    const short = prepared.short[m];
    const name = scopeName(prepared, view);
    const column = view.machineScope[m];
    const notProbed = m === prepared.notProbed;
    const caveats = [
      notProbed
        ? "Not probed: no test job on these labels recorded a machine."
        : "The machine is the one the jobs' test reports recorded, or for jobs without reports, their runner label's.",
      cell.row.owners.includes("unattributed:no_test_reports") &&
        "Test jobs with no recorded tests, so no owner split.",
      cell.row.owners.includes("unattributed:no_owner") &&
        "Tests in files with no owner.",
    ].filter((c): c is string => typeof c === "string");
    const labels = prepared.labels[m];
    body = (
      <>
        <Typography variant="h6" component="h3" sx={{ pr: 4, lineHeight: 1.3 }}>
          {cell.row.label} on {short}
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {machine} · {prepared.family[m]} · in {name}
        </Typography>
        <Typography
          sx={{
            mt: 1.5,
            fontSize: "1.75rem",
            fontWeight: 500,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {hoursLabel(detail.hours)}{" "}
          <Box
            component="span"
            sx={{
              fontSize: "0.95rem",
              color: "text.secondary",
              fontWeight: 400,
            }}
          >
            runner-hours
          </Box>
        </Typography>
        <Box component="ul" sx={{ pl: 2.5, my: 1, typography: "body2" }}>
          <li>
            {shareLabel(detail.hours / (column || 1))} of {short}&apos;s{" "}
            {hoursLabel(column)} h
          </li>
          <li>
            {shareLabel(detail.hours / (cell.row.hours || 1))} of{" "}
            {cell.row.label}&apos;s {hoursLabel(cell.row.hours)} h
          </li>
          <li>
            {shareLabel(detail.hours / (view.scopeTotal || 1))} of the{" "}
            {hoursLabel(view.scopeTotal)} h in {name}
          </li>
        </Box>
        <Heading>By workflow</Heading>
        {bars(detail.byWorkflow, detail.hours)}
        {cell.row.kind === "more" && (
          <>
            <Heading>Owners in this cell</Heading>
            {bars(detail.byOwner, detail.hours)}
          </>
        )}
        <Heading>Runner labels mapped to this machine</Heading>
        <Typography
          variant="body2"
          sx={{ color: "text.secondary", overflowWrap: "anywhere" }}
        >
          {labels.length === 0
            ? "None in the window."
            : labels.slice(0, 12).join(", ")}
          {labels.length > 12 ? `, and ${labels.length - 12} more` : ""}
        </Typography>
        <Heading>Test configs and files</Heading>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            border: `1px dashed ${theme.palette.divider}`,
            borderRadius: "4px",
            p: 1,
          }}
        >
          Not available yet.
        </Typography>
        <Heading>Caveats</Heading>
        <Box
          component="ul"
          sx={{ pl: 2.5, my: 0, typography: "body2", color: "text.secondary" }}
        >
          {caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </Box>
      </>
    );
  }
  return (
    <Drawer
      anchor="right"
      variant="persistent"
      open={cell !== null}
      slotProps={{
        paper: {
          sx: {
            width: WIDTH,
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
