import { Box, LinearProgress, Typography, useTheme } from "@mui/material";
import LoadError from "components/tests/LoadError";
import type { Dim } from "lib/api/tests/cost/contracts";
import {
  byNoun,
  byTitle,
  changeMetric,
  changeScale,
  cutRows,
  type DrillRow,
  halfScale,
  scopeName,
  sortRows,
  sumRows,
  TOP_N,
} from "lib/tests/cost/drill";
import ButterflyRow, {
  AxisRow,
  DrillBand,
  FewerRow,
  rowTooltip,
  SkeletonRows,
  swatchFor,
} from "./ButterflyRow";
import FileLevel from "./FileLevel";
import { type ExpandState, TreeRow } from "./TreeRows";
import type { DrillModel } from "./useDrill";

// The open row's children, inset under it on their own scale: a
// pinned owner's machines, a machine's owners, a pair's test files, a file's
// machines; a file on a machine opens its lanes (FileLevel); "No test
// reports" on a machine lists its runner labels. A click opens a row in
// place (an owner's machines and a machine's owners onto their runner
// labels, a file or a file's machine onto the file's lanes there); its
// Drill in key pins it.
export default function Canvas({
  drill,
  exp,
}: {
  drill: DrillModel;
  exp: ExpandState;
}) {
  const theme = useTheme();
  const level = drill.canvas;
  const by = drill.canvasBy;
  const { query, unit, per } = drill.input;
  const scope = scopeName(drill.trail, drill.root);
  const inset = {
    ml: 1.5,
    my: 0.5,
    pl: 1.5,
    pr: 1,
    py: 0.75,
    borderLeft: `3px solid ${theme.palette.primary.main}`,
    borderTop: `1px solid ${theme.palette.divider}`,
    borderBottom: `1px solid ${theme.palette.divider}`,
    position: "relative",
  } as const;
  const band = (
    <DrillBand
      small
      title={`${byTitle(by)} of ${scope}`}
      keys={
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          bars rescale to this level
        </Typography>
      }
    />
  );
  if (by === "lane") {
    return (
      <Box sx={inset}>
        <FileLevel drill={drill} />
      </Box>
    );
  }
  const view = level.view;
  if (level.error && !view) {
    return (
      <Box sx={inset}>
        {band}
        <LoadError
          what={`the ${byNoun(by, true)}`}
          error={level.error}
          onRetry={level.retry}
        />
      </Box>
    );
  }
  if (!view) {
    return (
      <Box sx={inset}>
        {band}
        <SkeletonRows />
      </Box>
    );
  }
  const sorted = sortRows(view.rows, query.sort, "h", view.aHasDays);
  const expanded = query.more.includes(by as Dim);
  const { shown, more } = cutRows(sorted, {
    top: TOP_N[by],
    expanded,
    keep: null,
  });
  const scale = halfScale(shown);
  const change = changeScale(shown.map((r) => changeMetric(r, "h")));
  const moreRow =
    more.length > 0
      ? sumRows(
          view,
          more.map((r) => r.key)
        )
      : null;
  const toggleMore = () =>
    drill.set({
      more: expanded
        ? query.more.filter((d) => d !== by)
        : [...query.more, by as Dim],
    });
  const swatch = (r: DrillRow) =>
    swatchFor(theme, {
      by,
      key: r.key,
      prepared: drill.input.runnerHours,
      named: drill.namedOwners,
    });
  const dim = level.stale || drill.preview !== null;
  const rowEl = (r: DrillRow) => (
    <TreeRow
      key={r.key}
      drill={drill}
      exp={exp}
      row={r}
      scope={drill.trail}
      depth={0}
      scale={scale}
      change={change}
      totals={view.total}
      parent={null}
      swatch={swatch(r)}
      stale={level.stale}
      tooltip={rowTooltip({
        row: r,
        context: `in ${scope}`,
        unit,
        per,
        parentB: view.total.b,
        parentName: scope,
      })}
    />
  );
  return (
    <Box sx={inset}>
      {band}
      <Box sx={{ position: "relative", height: 2 }}>
        {level.stale && <LinearProgress sx={{ height: 2 }} />}
      </Box>
      <Box
        role="table"
        aria-label={`${byTitle(by)} of ${scope}`}
        sx={{ opacity: dim ? 0.5 : 1 }}
      >
        <AxisRow scale={scale} change={change} chg={"h"} unit={unit} />
        {shown.filter((r) => !r.bucket).map(rowEl)}
        {moreRow && (
          <ButterflyRow
            row={moreRow}
            kind="more"
            depth={0}
            totals={view.total}
            label={`${more.length} more ${byNoun(by, more.length !== 1)} ▸`}
            scale={scale}
            change={change}
            chg={"h"}
            unit={unit}
            per={per}
            stale={level.stale}
            onClick={toggleMore}
          />
        )}
        {expanded && sorted.length > TOP_N[by] && (
          <FewerRow onClick={toggleMore} />
        )}
        {shown.filter((r) => r.bucket).map(rowEl)}
        {shown.length === 0 && (
          <Typography variant="body2" sx={{ color: "text.secondary", py: 1 }}>
            No {byNoun(by, true)} with runner-hours here in A or B.
          </Typography>
        )}
      </Box>
      {by === "label" && (
        <Typography
          variant="caption"
          component="p"
          sx={{ color: "text.secondary", mt: 0.5 }}
        >
          Jobs without test reports have no files; these are their runner
          labels.
        </Typography>
      )}
    </Box>
  );
}
