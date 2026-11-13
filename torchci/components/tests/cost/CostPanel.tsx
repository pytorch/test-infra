import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import { Box, Collapse, Tooltip, Typography, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import CostFrame from "components/tests/cost/CostFrame";
import RatesDropzone, {
  RatesAction,
} from "components/tests/cost/RatesDropzone";
import RatesFormat from "components/tests/cost/RatesFormat";
import FactPill from "components/tests/FactPill";
import { VIEW_CHIP_HEIGHT } from "components/tests/ViewChips";
import { datesLabel, hoursLabel, rateLabel } from "lib/tests/cost/query";
import {
  editedRates,
  priceableRunners,
  ratesCoverage,
  type RatesFile,
} from "lib/tests/cost/rates";
import type { PreparedHours } from "lib/tests/cost/runnerHours";
import type { RatesHandoff } from "lib/tests/cost/useRatesHandoff";
import { headerKeyFocusRing } from "lib/tests/headerColors";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface CostPanelFrame {
  open: boolean;
  onOpenChange: (_open: boolean) => void;
  // The line under the chart's band naming the rates file.
  banner: ReactNode;
}

export interface CostPanelProps {
  // The answer in runner-hours: its runners are what a file prices.
  prepared: PreparedHours;
  rates: RatesFile | null;
  error: string | null;
  // The one-click way to the internal rates, where the origin has one.
  handoff?: RatesHandoff | null;
  onFile: (_file: File) => void;
  onClear: () => void;
  onDismissError: () => void;
  // Puts the file's rates back over the edits made in the key.
  onUndoEdits: () => void;
  // The owner chart in $, in the frame given.
  chart: (_frame: CostPanelFrame) => ReactNode;
}

const DESCRIPTION =
  "Runner-hours (as in the chart above) × each runner's $/h from your rates.";

// Words that list what they count on hover. The list describes them, so a
// screen reader reads the words and then the list (describeChild).
function ListTip({
  lines,
  accent = false,
  children,
}: {
  lines: string[];
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip
      describeChild
      title={lines.join("\n")}
      slotProps={{
        tooltip: { sx: { whiteSpace: "pre-line", maxWidth: 460 } },
      }}
    >
      <Box
        component="span"
        tabIndex={0}
        sx={{
          ...(accent ? { color: "primary.main", fontWeight: 500 } : {}),
          textDecoration: "underline dotted",
          textUnderlineOffset: "3px",
          cursor: "help",
        }}
      >
        {children}
      </Box>
    </Tooltip>
  );
}

// What a file's usage window is, and how the page uses it. The days count
// from its "YYYY-MM-DD" ends read as UTC, so no time zone moves them.
function windowTip(start: string, end: string): string {
  const days =
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
      86_400_000 +
    1;
  return `${
    days === 1
      ? "Each rate is the average over this UTC day of usage."
      : `Each rate is the average over these ${days} UTC days of usage, first and last included.`
  } The page prices all its days with these rates.`;
}

// The cost page's panel in $, under the runner-hours chart: until a rates
// file is added its body asks for one (RatesDropzone); then it is the owner
// chart in $, a line under its band naming the file, how much of the
// window's runner-hours it prices, and ways to replace or clear it. A file
// dropped anywhere on the page is taken, so a miss never opens the file in
// the tab. The file is read into the page's memory only (rates.ts).
export default function CostPanel({
  prepared,
  rates,
  error,
  handoff = null,
  onFile,
  onClear,
  onDismissError,
  onUndoEdits,
  chart,
}: CostPanelProps) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const picker = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const runners = useMemo(() => priceableRunners(prepared), [prepared]);
  const coverage = useMemo(
    () => (rates === null ? null : ratesCoverage(prepared, rates)),
    [prepared, rates]
  );
  const take = useCallback(
    (file: File) => {
      setOpen(true);
      onFile(file);
    },
    [onFile]
  );

  // A file dragged over the page lights the panel up; dropped anywhere, it
  // is taken.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      if (file !== undefined) take(file);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [take]);

  const choose = () => picker.current?.click();
  const examples = runners.slice(0, 2).map((r) => r.label);
  const warning = dark ? theme.palette.error.light : theme.palette.error.dark;
  const input = (
    <input
      ref={picker}
      type="file"
      accept="application/json,.json"
      hidden
      onChange={(event) => {
        const file = event.target.files?.[0];
        // Cleared, so the same file can be picked again after an edit.
        event.target.value = "";
        if (file !== undefined) take(file);
      }}
    />
  );

  if (rates === null || coverage === null) {
    return (
      <Box>
        {input}
        <CostFrame
          title="Cost by owner"
          description={DESCRIPTION}
          note="· apply rates"
          open={open}
          onOpenChange={setOpen}
        >
          <RatesDropzone
            dragging={dragging}
            error={error}
            handoff={handoff}
            exampleLabels={examples}
            runners={runners.length}
            onChoose={choose}
            onDismissError={onDismissError}
          />
        </CostFrame>
      </Box>
    );
  }

  const edits = editedRates(rates);
  const rateText = (r: number | undefined) =>
    r === undefined ? "no rate" : rateLabel(r);
  const dot = (
    <Box component="span" aria-hidden sx={{ color: "text.disabled" }}>
      ·
    </Box>
  );
  // With the window's pill, the first row is the pill's height and the
  // actions are centered on it, so they stay level with the file's name.
  const firstRow = rates.window === null ? undefined : `${VIEW_CHIP_HEIGHT}px`;
  const banner = (
    <Box sx={{ typography: "body2", color: "text.secondary" }}>
      <Box sx={{ display: "flex", alignItems: "flex-start", columnGap: 2 }}>
        {/* What the file is, wrapping as it must; its actions kept together
            at the end. */}
        <Box
          sx={{
            flex: "1 1 auto",
            minWidth: 0,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            columnGap: 1,
            rowGap: 0.5,
          }}
        >
          <InsertDriveFileOutlinedIcon
            sx={{ fontSize: 18, color: "text.secondary" }}
          />
          <Box
            component="span"
            sx={{
              color: "text.primary",
              fontWeight: 500,
              lineHeight: firstRow,
            }}
          >
            {rates.file}
          </Box>
          <span>(in this tab only)</span>
          {edits.length > 0 && (
            <span>
              {dot}{" "}
              <ListTip
                accent
                lines={[
                  "Edited in the key:",
                  ...edits
                    .slice(0, 8)
                    .map(
                      (k) =>
                        `${k}: ${rateText(rates.original[k])} → ${rateText(
                          rates.rates[k]
                        )}`
                    ),
                  ...(edits.length > 8 ? [`+ ${edits.length - 8} more`] : []),
                ]}
              >
                {edits.length} edited
              </ListTip>{" "}
              (
              <RatesAction label="Undo the edits" onClick={onUndoEdits}>
                Undo
              </RatesAction>
              )
            </span>
          )}
          {/* The pill is read, not pressed: it takes focus only so its
              tooltip reaches the keyboard and a screen reader. */}
          {rates.window !== null && (
            <Tooltip
              describeChild
              title={windowTip(rates.window.start, rates.window.end)}
              slotProps={{ tooltip: { sx: { maxWidth: 460 } } }}
            >
              <Box
                component="span"
                tabIndex={0}
                sx={{
                  display: "inline-flex",
                  borderRadius: "999px",
                  cursor: "help",
                  "&:focus-visible": headerKeyFocusRing(theme),
                }}
              >
                <FactPill label="Rates averaged over">
                  {datesLabel(rates.window.start, rates.window.end)}
                </FactPill>
              </Box>
            </Tooltip>
          )}
          {/* A generated file's valid_from is its window's last day, which
              the window already says. */}
          {rates.validFrom !== null &&
            rates.validFrom !== rates.window?.end && (
              <span>
                {dot} valid from {rates.validFrom}
              </span>
            )}
          {rates.basis !== null && (
            <span>
              {dot} {rates.basis}
            </span>
          )}
          {coverage.missing.length > 0 && (
            <span>
              {dot}{" "}
              <ListTip
                lines={[
                  "No rate, largest first:",
                  ...coverage.missing
                    .slice(0, 8)
                    .map((r) => `${r.label}: ${hoursLabel(r.hours)} h`),
                  ...(coverage.missing.length > 8
                    ? [`+ ${coverage.missing.length - 8} more`]
                    : []),
                ]}
              >
                {coverage.missing.length}{" "}
                {coverage.missing.length === 1
                  ? "runner has no rate"
                  : "runners have no rate"}
              </ListTip>
            </span>
          )}
          {coverage.unused.length > 0 && (
            <span>
              {dot}{" "}
              <ListTip
                lines={[
                  "No runner by these labels ran in this window:",
                  ...coverage.unused.slice(0, 8),
                  ...(coverage.unused.length > 8
                    ? [`+ ${coverage.unused.length - 8} more`]
                    : []),
                ]}
              >
                {coverage.unused.length}{" "}
                {coverage.unused.length === 1
                  ? "label didn't run here"
                  : "labels didn't run here"}
              </ListTip>
            </span>
          )}
        </Box>
        <Box
          sx={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            minHeight: firstRow,
            columnGap: 1,
            whiteSpace: "nowrap",
          }}
        >
          <RatesAction label="Choose a different rates file" onClick={choose}>
            Replace…
          </RatesAction>
          {dot}
          <RatesAction label="Clear the rates" onClick={onClear}>
            Clear
          </RatesAction>
          {dot}
          <RatesAction
            label={formatOpen ? "Hide the file format" : "Show the file format"}
            onClick={() => setFormatOpen(!formatOpen)}
          >
            {formatOpen ? "Hide file format" : "File format"}
          </RatesAction>
        </Box>
      </Box>
      <Box role="alert">
        {error !== null && (
          <Typography variant="body2" sx={{ color: warning, mt: 0.5 }}>
            <b>Kept {rates.file}.</b> {error}{" "}
            <RatesAction label="Dismiss the error" onClick={onDismissError}>
              Dismiss
            </RatesAction>
          </Typography>
        )}
      </Box>
      <Collapse in={formatOpen}>
        <Box
          sx={{
            mt: 1,
            p: 1.5,
            width: "fit-content",
            maxWidth: "100%",
            borderRadius: "6px",
            border: `1px solid ${theme.palette.divider}`,
          }}
        >
          <RatesFormat exampleLabels={examples} runners={runners.length} />
        </Box>
      </Collapse>
    </Box>
  );
  return (
    <Box sx={{ position: "relative" }}>
      {input}
      {chart({ open, onOpenChange: setOpen, banner })}
      {dragging && (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            zIndex: 2,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 1,
            pointerEvents: "none",
            borderRadius: `${Number(theme.shape.borderRadius)}px`,
            border: `2px solid ${theme.palette.primary.main}`,
            backgroundColor: alpha(theme.palette.background.paper, 0.88),
            color: "primary.main",
            typography: "h6",
          }}
        >
          <InsertDriveFileOutlinedIcon />
          Drop to replace your rates
        </Box>
      )}
    </Box>
  );
}
