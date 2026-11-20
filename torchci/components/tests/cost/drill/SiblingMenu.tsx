import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import {
  Box,
  InputBase,
  MenuItem,
  MenuList,
  Popover,
  Typography,
  useTheme,
} from "@mui/material";
import type { Unit } from "lib/api/tests/cost/contracts";
import { amount, changeText, type DrillRow } from "lib/tests/cost/drill";
import { useMemo, useState } from "react";
import { drillColors, Swatch, toneOf } from "./ButterflyRow";

// Lists with more rows than this get a filter box.
const FILTER_FROM = 15;
// About 8 rows, then the list scrolls, so a preview leaves the bars in view.
const MAX_HEIGHT = 340;

export interface SiblingMenuProps {
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  title: string; // "Owners of all test jobs"
  rows: readonly DrillRow[]; // sorted, hidden rows left out
  currentKey: string | null;
  unit: Unit;
  swatchOf: (_row: DrillRow) => string | null;
  // Hover or ↑↓ previews a row (null cancels); click or Enter picks it.
  onPreview: (_key: string | null) => void;
  onPick: (_key: string) => void;
}

// The ▾ list of a pill (and the fold line's, and "+ next"'s): each sibling
// with its swatch, mini A|B bars on one scale, A, B and %, the current one
// checked. Hovering or arrowing previews it across the head and the bars;
// a click swaps it in. Esc, a click outside or leaving the list cancels the
// preview. Opened only by a click: no tip opens on its own.
export default function SiblingMenu({
  anchorEl,
  open,
  onClose,
  title,
  rows,
  currentKey,
  unit,
  swatchOf,
  onPreview,
  onPick,
}: SiblingMenuProps) {
  const theme = useTheme();
  const c = drillColors(theme);
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f === ""
      ? rows
      : rows.filter((r) => `${r.detail}${r.name}`.toLowerCase().includes(f));
  }, [rows, filter]);
  const top = Math.max(1e-9, ...rows.flatMap((r) => [r.a ?? 0, r.b ?? 0]));
  // Open upward when there is room above the pill: the head and the bars
  // below it are what a preview changes.
  const up =
    open &&
    anchorEl !== null &&
    anchorEl.getBoundingClientRect().top > MAX_HEIGHT + 24;
  const close = () => {
    onPreview(null);
    setFilter("");
    onClose();
  };
  const bar = (v: number | null, color: string) => (
    <Box
      sx={{
        height: 4,
        width: `${Math.max(0, Math.min(1, (v ?? 0) / top)) * 100}%`,
        bgcolor: color,
        borderRadius: "1px",
      }}
    />
  );
  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={close}
      anchorOrigin={{ vertical: up ? "top" : "bottom", horizontal: "left" }}
      transformOrigin={{ vertical: up ? "bottom" : "top", horizontal: "left" }}
      slotProps={{
        paper: {
          onMouseLeave: () => onPreview(null),
          sx: {
            width: 600,
            maxWidth: "calc(100vw - 32px)",
            maxHeight: MAX_HEIGHT,
            display: "flex",
            flexDirection: "column",
          },
        },
      }}
    >
      <Box sx={{ px: 1.5, pt: 1, pb: 0.5 }}>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {title}
        </Typography>
        {rows.length > FILTER_FROM && (
          <InputBase
            autoFocus
            placeholder="Filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                const first = (
                  e.currentTarget.closest(
                    ".MuiPopover-paper"
                  ) as HTMLElement | null
                )?.querySelector<HTMLElement>('[role="menuitem"]');
                first?.focus();
              }
              e.stopPropagation();
            }}
            inputProps={{ "aria-label": `Filter ${title}` }}
            sx={{
              display: "flex",
              mt: 0.5,
              px: 1,
              py: 0.25,
              typography: "body2",
              border: `1px solid ${theme.palette.divider}`,
              borderRadius: 1,
            }}
          />
        )}
      </Box>
      <MenuList
        dense
        autoFocusItem={rows.length <= FILTER_FROM}
        aria-label={title}
        sx={{ overflowY: "auto", py: 0.5 }}
      >
        {shown.map((r) => {
          const isCurrent = r.key === currentKey;
          const tone = toneOf(r.delta);
          return (
            <MenuItem
              key={r.key}
              selected={isCurrent}
              onMouseEnter={() => onPreview(isCurrent ? null : r.key)}
              onFocus={() => onPreview(isCurrent ? null : r.key)}
              onClick={() => {
                if (!isCurrent) onPick(r.key);
                close();
              }}
              sx={{
                display: "grid",
                gridTemplateColumns: "16px minmax(0,1fr) 56px 60px 60px 56px",
                columnGap: 1,
                alignItems: "center",
                typography: "body2",
              }}
            >
              <Box sx={{ display: "flex", color: "primary.main" }}>
                {isCurrent && <CheckRoundedIcon sx={{ fontSize: 16 }} />}
              </Box>
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.75,
                  minWidth: 0,
                  fontWeight: isCurrent ? 600 : 400,
                }}
              >
                <Swatch fill={swatchOf(r)} />
                <Box
                  component="span"
                  title={`${r.detail}${r.name}`}
                  sx={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.name}
                </Box>
              </Box>
              <Box
                sx={{ display: "flex", flexDirection: "column", gap: "2px" }}
              >
                {bar(r.a, c.a)}
                {bar(r.b, c.b)}
              </Box>
              <Box
                sx={{
                  textAlign: "right",
                  color: "text.secondary",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {r.a === null ? "–" : amount(unit, r.a)}
              </Box>
              <Box
                sx={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
              >
                {r.b === null ? "–" : amount(unit, r.b)}
              </Box>
              <Box
                sx={{
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                  color:
                    tone === "up"
                      ? c.upText
                      : tone === "down"
                      ? c.down
                      : "text.secondary",
                }}
              >
                {changeText(r)}
              </Box>
            </MenuItem>
          );
        })}
        {shown.length === 0 && (
          <MenuItem disabled sx={{ typography: "body2" }}>
            Nothing matches
          </MenuItem>
        )}
      </MenuList>
    </Popover>
  );
}
