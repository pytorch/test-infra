import { Box, LinearProgress, Typography, useTheme } from "@mui/material";
import LoadError from "components/tests/LoadError";
import {
  amount,
  arrowText,
  type DrillRow,
  fileShort,
  halfScale,
  type LaneGroup,
  laneGroups,
  scopeName,
  sortRows,
  testHoursText,
  workflowShort,
} from "lib/tests/cost/drill";
import { headerBandColor } from "lib/tests/headerColors";
import {
  ChangeTexts,
  DrillBand,
  drillColors,
  MiniMark,
  SkeletonRows,
} from "./ButterflyRow";
import CasesPanel from "./CasesPanel";
import type { DrillModel } from "./useDrill";

export const LANE_GRID =
  "minmax(0,3.2fr) minmax(56px,0.8fr) 64px 64px 80px 68px 120px 124px";

export type { LaneGroup };

// A runner label as a chip, B's hours a day on it in bold (whatever the
// unit): a lane's split by runner label, here and (dense, a line each in a
// narrow name column) in a file opened in place.
export function LabelChip({
  label,
  workflow,
  hours,
  title,
  dense = false,
}: {
  label: string;
  workflow?: string;
  hours: number;
  title?: string;
  dense?: boolean;
}) {
  const theme = useTheme();
  return (
    <Box
      component="span"
      title={title}
      sx={{
        typography: "caption",
        lineHeight: dense ? "16px" : undefined,
        fontFamily: "monospace",
        px: 0.75,
        borderRadius: 1,
        bgcolor: headerBandColor(theme),
        color: "text.secondary",
        whiteSpace: "nowrap",
      }}
    >
      {label} {workflow !== undefined && `${workflow} `}
      <Box component="span" sx={{ color: "text.primary", fontWeight: 600 }}>
        {amount("hours", hours)}
      </Box>
    </Box>
  );
}

// A file on a machine: one row per environment, tokens every lane
// shares lifted into one line above, each lane's runner label × workflow
// chips with B's hours inside; A|B mark, A, B, change, %, the other per and
// test time a day from test_cost. Under them, configurations and test cases
// on demand (CasesPanel).
export default function FileLevel({ drill }: { drill: DrillModel }) {
  const theme = useTheme();
  const c = drillColors(theme);
  const level = drill.canvas;
  const view = level.view;
  const { query, unit, per } = drill.input;
  const scope = scopeName(drill.trail, drill.root);
  const band = (
    <DrillBand
      small
      title={`Environments of ${scope}`}
      keys={
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          bars rescale to this level
        </Typography>
      }
    />
  );
  if (level.error && !view) {
    return (
      <>
        {band}
        <LoadError
          what="the environments"
          error={level.error}
          onRetry={level.retry}
        />
      </>
    );
  }
  if (!view) {
    return (
      <>
        {band}
        <SkeletonRows n={4} />
      </>
    );
  }
  const { common, groups: unsorted } = laneGroups(view);
  const order = sortRows(
    unsorted.map((g) => g.row),
    query.sort,
    query.chg,
    view.aHasDays
  ).map((r) => r.key);
  const groups = [...unsorted].sort(
    (x, y) => order.indexOf(x.envId) - order.indexOf(y.envId)
  );
  const testsOf = (rows: DrillRow[]) => {
    const t = { a: 0, b: 0 };
    for (const r of rows) {
      t.a += r.tests?.a ?? 0;
      t.b += r.tests?.b ?? 0;
    }
    return t;
  };
  const top = halfScale(groups.map((g) => g.row)).top;
  const head = {
    typography: "caption",
    color: "text.secondary",
    textAlign: "right",
    px: 0.75,
    whiteSpace: "nowrap",
  } as const;
  const numSx = {
    textAlign: "right",
    px: 0.75,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  } as const;
  const otherPer = per === "day" ? "Per commit" : "Per day";
  return (
    <>
      {band}
      <Box sx={{ position: "relative", height: 2 }}>
        {level.stale && <LinearProgress sx={{ height: 2 }} />}
      </Box>
      {common.length > 0 && (
        <Typography
          variant="caption"
          component="p"
          sx={{ color: "text.secondary", mb: 0.5 }}
        >
          Every lane runs on {common.join(" · ")}.
        </Typography>
      )}
      <Box
        role="table"
        aria-label={`Environments of ${scope}`}
        sx={{ opacity: level.stale || drill.preview ? 0.5 : 1 }}
      >
        <Box
          role="row"
          sx={{
            display: "grid",
            gridTemplateColumns: LANE_GRID,
            alignItems: "end",
            pb: 0.25,
            borderBottom: `1px solid ${theme.palette.divider}`,
          }}
        >
          <Box sx={{ ...head, textAlign: "left" }}>
            Environment and runner labels
          </Box>
          <Box sx={{ ...head, textAlign: "left" }}>A | B</Box>
          <Box sx={head}>A</Box>
          <Box sx={head}>B</Box>
          <Box sx={head}>Change</Box>
          <Box sx={head}>%</Box>
          <Box sx={head}>{otherPer} A → B</Box>
          <Box sx={head}>Test time a day A → B</Box>
        </Box>
        {groups.map((g) => {
          const t = testsOf(g.children);
          return (
            <Box
              key={g.envId}
              role="row"
              onMouseEnter={() =>
                drill.setHover({
                  by: "lane",
                  children: g.children.map((r) => r.key),
                })
              }
              onMouseLeave={() => drill.setHover(null)}
              sx={{
                display: "grid",
                gridTemplateColumns: LANE_GRID,
                alignItems: "center",
                py: 0.5,
                typography: "body2",
                borderBottom: `1px solid ${theme.palette.divider}`,
                "&:hover": { backgroundColor: c.hover },
              }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Box sx={{ fontWeight: 500 }}>{g.name}</Box>
                <Box
                  sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.25 }}
                >
                  {g.children.flatMap((r) =>
                    (r.labels.length > 0
                      ? r.labels
                      : [{ label: "", b: r.b ?? 0 }]
                    ).map((l) => (
                      <LabelChip
                        key={`${r.key}|${l.label}`}
                        label={l.label}
                        workflow={workflowShort(
                          r.info.workflow ?? r.key.split("|")[1] ?? ""
                        )}
                        hours={l.b}
                        title={r.info.workflow}
                      />
                    ))
                  )}
                </Box>
              </Box>
              <Box sx={{ pr: 1 }}>
                <MiniMark a={g.row.a} b={g.row.b} top={top} />
              </Box>
              <Box sx={{ ...numSx, color: "text.secondary" }}>
                {g.row.a === null
                  ? g.row.blankA
                  : `${g.row.approxA ? "≈" : ""}${amount(unit, g.row.a)}`}
              </Box>
              <Box sx={{ ...numSx, fontWeight: 600 }}>
                {g.row.b === null
                  ? g.row.blankB
                  : `${g.row.approxB ? "≈" : ""}${amount(unit, g.row.b)}`}
              </Box>
              <ChangeTexts row={g.row} unit={unit} />
              <Box sx={{ ...numSx, color: "text.secondary" }}>
                {per === "day" && g.row.notOnMain
                  ? "not on main"
                  : arrowText(
                      unit,
                      g.row.other.a,
                      g.row.other.b,
                      g.row.approxA,
                      g.row.approxB
                    )}
              </Box>
              <Box sx={{ ...numSx, color: "text.secondary" }}>
                {testHoursText(t.a)} → {testHoursText(t.b)}
              </Box>
            </Box>
          );
        })}
        {groups.length === 0 && (
          <Typography variant="body2" sx={{ color: "text.secondary", py: 1 }}>
            No lanes of {fileShort(drill.cases.file ?? "")} have runner-hours
            here in A or B.
          </Typography>
        )}
      </Box>
      <CasesPanel drill={drill} lanes={groups} />
    </>
  );
}
