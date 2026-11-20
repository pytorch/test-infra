import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import KeyboardArrowDownRoundedIcon from "@mui/icons-material/KeyboardArrowDownRounded";
import SwapHorizRoundedIcon from "@mui/icons-material/SwapHorizRounded";
import {
  Box,
  ButtonBase,
  Link,
  Menu,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { lighten } from "@mui/material/styles";
import KeyButton from "components/tests/cost/KeyButton";
import { VIEW_CHIP_HEIGHT } from "components/tests/ViewChips";
import { childBy, type Pill } from "lib/api/tests/cost/contracts";
import {
  amount,
  byNoun,
  byTitle,
  canFlip,
  changeText,
  type DrillRow,
  scopeName,
  sortRows,
} from "lib/tests/cost/drill";
import { headerBandColor, headerBandHoverColor } from "lib/tests/headerColors";
import { type KeyboardEvent, type MouseEvent, useState } from "react";
import { drillColors, Swatch, swatchFor, toneOf } from "./ButterflyRow";
import SiblingMenu from "./SiblingMenu";
import type { DrillModel, LevelState } from "./useDrill";

// Esc or Backspace climbs one, scoped to the drill's parts: not
// while typing or while a menu is open, and the page's own Esc skips it.
export function drillKeys(drill: DrillModel) {
  return (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key !== "Escape" && e.key !== "Backspace") return;
    const t = e.target as HTMLElement;
    if (t.closest("input,textarea,[contenteditable=true],[role=menu]")) return;
    if (drill.preview !== null) {
      e.preventDefault();
      drill.setPreview(null);
      return;
    }
    if (drill.trail.length === 0) return;
    e.preventDefault();
    drill.climbOne();
  };
}

// The rows a menu lists: a level's children, hidden ones left out, in the
// table's order.
export function menuRows(
  level: LevelState | undefined,
  drill: DrillModel
): DrillRow[] {
  const view = level?.view;
  if (!view) return [];
  return sortRows(
    view.rows.filter((r) => !r.hidden),
    drill.input.query.sort,
    drill.input.query.chg,
    view.aHasDays
  );
}

interface Menu {
  k: number; // pill k's siblings; trail.length for "+ next"; -1 the root ▾
  anchor: HTMLElement;
}

// SCOPE [All owners 43.9K h ▼13% ▾] › [inductor … ▾ ✕] ⇄ [■ Linux x86_64
// avx512 … ▾ ✕] › [+ test file ▾] ............ Open in tests list ↗
// Each pill shows its scope's B and change; its name climbs to it (the last
// is inert); ▾ lists its siblings to preview and swap; ✕ drops it and keeps
// the rest; ⇄ flips an adjacent owner and machine.
export default function ScopeTrail({ drill }: { drill: DrillModel }) {
  const theme = useTheme();
  const c = drillColors(theme);
  const [menu, setMenu] = useState<Menu | null>(null);
  const unit = drill.input.unit;
  const prepared = drill.input.runnerHours;
  const { trail, root } = drill;
  // A pill's name that climbs, on the pill grey at 4.5:1 in both modes.
  const linkColor =
    theme.palette.mode === "dark"
      ? lighten(theme.palette.primary.main, 0.4)
      : theme.palette.primary.dark;
  // Every pill shares A's and B's days; the head's chips say
  // how many are priced, and each pill's figures repeat it on hover.
  const pricedTitle =
    drill.head.chips
      .filter((chip) => chip.endsWith("days priced"))
      .join("; ") || undefined;

  const pillBox = (last: boolean, dashed = false) => ({
    display: "inline-flex",
    alignItems: "center",
    height: VIEW_CHIP_HEIGHT,
    borderRadius: "999px",
    backgroundColor: dashed ? "transparent" : headerBandColor(theme),
    border: dashed
      ? `1px dashed ${theme.palette.divider}`
      : last
      ? `1px solid ${theme.palette.primary.main}`
      : "1px solid transparent",
    whiteSpace: "nowrap",
    typography: "body2",
    pl: 1.25,
    pr: 0.25,
    gap: 0.75,
  });
  const iconKey = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    borderRadius: "999px",
    color: "text.secondary",
    "&:hover": { backgroundColor: headerBandHoverColor(theme) },
    "&.Mui-focusVisible": {
      outline: `2px solid ${theme.palette.primary.main}`,
    },
  } as const;

  const figures = (row: DrillRow | null, stale: boolean) => {
    if (stale || row === null) {
      return (
        <Box component="span" sx={{ color: "text.disabled" }}>
          …
        </Box>
      );
    }
    const tone = toneOf(row.delta);
    return (
      <>
        <Box
          component="span"
          title={pricedTitle}
          sx={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
        >
          {row.b === null
            ? "–"
            : `${row.approxB ? "≈" : ""}${amount(unit, row.b)}`}
        </Box>
        {row.a !== null && (
          <Box
            component="span"
            sx={{
              fontSize: theme.typography.caption.fontSize,
              fontVariantNumeric: "tabular-nums",
              color:
                tone === "up"
                  ? c.upText
                  : tone === "down"
                  ? c.down
                  : "text.secondary",
            }}
          >
            {changeText(row)}
          </Box>
        )}
      </>
    );
  };

  const swatchOfPill = (pill: Pill) =>
    pill.dim === "m"
      ? swatchFor(theme, { by: "m", key: pill.value, prepared, named: null })
      : null;

  const menuLevel = (k: number): LevelState | undefined =>
    k === trail.length ? drill.canvas : drill.levels[k];
  const menuTitle = (k: number) => {
    const scope = trail.slice(0, k);
    const by = k === trail.length ? childBy(trail, root) : trail[k].dim;
    return `${byTitle(by)} of ${
      scope.length === 0 ? "all test jobs" : scopeName(scope, root)
    }`;
  };
  const menuBy = (k: number) =>
    k === trail.length ? childBy(trail, root) : trail[k].dim;

  const openMenu = (k: number) => (e: MouseEvent<HTMLElement>) =>
    setMenu({
      k,
      anchor:
        (e.currentTarget.closest("[data-pill]") as HTMLElement | null) ??
        e.currentTarget,
    });

  const testsTitle =
    "The tests list for this scope: rolling 14 days, main and pull requests, not A and B";

  return (
    <Box
      component="nav"
      aria-label="Scope"
      onKeyDown={drillKeys(drill)}
      sx={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 0.75,
        py: 0.5,
      }}
    >
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          fontWeight: 700,
          letterSpacing: "0.08em",
          mr: 0.5,
        }}
      >
        SCOPE
      </Typography>
      {/* The first split, said out loud: by owner (why an owner's hours
          changed) or by machine (how the fleet's use changed). Switching
          keeps the trail where it can (chooseRoot). */}
      <Box sx={{ display: "inline-flex", gap: 0.5 }}>
        <KeyButton
          title="By owner: start from whose tests the hours are, for an owner asking why their hours changed"
          active={root === "o"}
          onClick={() => root !== "o" && drill.setRoot("o")}
        >
          By owner
        </KeyButton>
        <KeyButton
          title="By machine: start from the hardware the hours ran on, for how the fleet's use changed"
          active={root === "m"}
          onClick={() => root !== "m" && drill.setRoot("m")}
        >
          By machine
        </KeyButton>
      </Box>
      {/* root pill: every test job in the scope */}
      <Box data-pill sx={pillBox(trail.length === 0)}>
        <ButtonBase
          aria-current={trail.length === 0 ? "location" : undefined}
          disabled={trail.length === 0}
          onClick={() => drill.climbTo(-1)}
          sx={{
            typography: "body2",
            color: trail.length === 0 ? "text.primary" : linkColor,
            fontWeight: trail.length === 0 ? 600 : 400,
          }}
        >
          All test jobs
        </ButtonBase>
        {figures(drill.pills[0].row, drill.pills[0].stale)}
        <Box sx={{ width: 4 }} />
      </Box>
      {trail.map((pill, k) => {
        const view = drill.pills[k + 1];
        const flip = k > 0 && canFlip(trail, k - 1);
        return (
          <Box key={`${pill.dim}:${pill.value}`} sx={{ display: "contents" }}>
            {flip ? (
              <Tooltip
                title="Flip owner and machine (same scope)"
                enterDelay={600}
              >
                <ButtonBase
                  aria-label="Flip owner and machine"
                  onClick={() => drill.flip(k - 1)}
                  sx={{
                    ...iconKey,
                    border: `1px solid ${theme.palette.divider}`,
                  }}
                >
                  <SwapHorizRoundedIcon sx={{ fontSize: 16 }} />
                </ButtonBase>
              </Tooltip>
            ) : (
              <Box component="span" aria-hidden sx={{ color: "text.disabled" }}>
                ›
              </Box>
            )}
            <Box
              data-pill
              title={pill.dim === "f" ? pill.value : undefined}
              sx={{
                ...pillBox(view.last),
                ...(drill.preview?.k === k
                  ? {
                      outline: `1px dashed ${theme.palette.primary.main}`,
                      outlineOffset: 2,
                    }
                  : {}),
              }}
            >
              <Swatch fill={swatchOfPill(pill)} />
              <ButtonBase
                aria-current={view.last ? "location" : undefined}
                disabled={view.last}
                onClick={() => drill.climbTo(k)}
                sx={{
                  typography: "body2",
                  color: view.last ? "text.primary" : linkColor,
                  fontWeight: view.last ? 600 : 400,
                  maxWidth: 260,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  display: "block",
                }}
              >
                {view.name}
              </ButtonBase>
              {figures(view.row, view.stale)}
              <ButtonBase
                aria-label={`Other ${byNoun(pill.dim, true)}`}
                onClick={openMenu(k)}
                sx={iconKey}
              >
                <KeyboardArrowDownRoundedIcon sx={{ fontSize: 18 }} />
              </ButtonBase>
              <ButtonBase
                aria-label={`Drop ${view.name}`}
                onClick={() => drill.drop(k)}
                sx={iconKey}
              >
                <CloseRoundedIcon sx={{ fontSize: 14 }} />
              </ButtonBase>
            </Box>
          </Box>
        );
      })}
      {drill.next !== null && (
        <>
          <Box component="span" aria-hidden sx={{ color: "text.disabled" }}>
            ›
          </Box>
          <Box
            data-pill
            sx={{ ...pillBox(false, true), color: "text.secondary", pl: 0 }}
          >
            <ButtonBase
              onClick={openMenu(trail.length)}
              sx={{
                typography: "body2",
                color: "text.secondary",
                pl: 1.25,
                pr: 0.25,
                height: "100%",
                borderRadius: "999px",
              }}
            >
              + {byNoun(drill.next)}
              <KeyboardArrowDownRoundedIcon sx={{ fontSize: 18, ml: 0.25 }} />
            </ButtonBase>
          </Box>
        </>
      )}
      {trail.length > 0 && (
        // Back to the top level in one click: every pill dropped.
        <ButtonBase
          onClick={() => drill.climbTo(-1)}
          title="Clear the scope: back to all owners or machines"
          sx={{
            typography: "body2",
            color: "text.secondary",
            px: 0.75,
            height: 28,
            borderRadius: 1,
            whiteSpace: "nowrap",
            "&:hover": { color: "text.primary", textDecoration: "underline" },
          }}
        >
          Reset
        </ButtonBase>
      )}
      {drill.testsHref && (
        <Tooltip title={testsTitle} enterDelay={600}>
          <Link
            href={drill.testsHref}
            underline="hover"
            sx={{ typography: "body2", whiteSpace: "nowrap", ml: "auto" }}
          >
            Open in tests list ↗
          </Link>
        </Tooltip>
      )}

      {menu !== null && menu.k >= 0 && (
        <SiblingMenu
          open
          anchorEl={menu.anchor}
          onClose={() => setMenu(null)}
          title={menuTitle(menu.k)}
          rows={menuRows(menuLevel(menu.k), drill)}
          currentKey={menu.k < trail.length ? trail[menu.k].value : null}
          unit={unit}
          swatchOf={(r) =>
            swatchFor(theme, {
              by: menuBy(menu.k),
              key: r.key,
              prepared,
              named: null,
            })
          }
          onPreview={(key) =>
            drill.setPreview(key === null ? null : { k: menu.k, value: key })
          }
          onPick={(key) => {
            const k = menu.k;
            if (k < trail.length) drill.swap(k, key);
            else if (drill.next) drill.append({ dim: drill.next, value: key });
          }}
        />
      )}
    </Box>
  );
}
