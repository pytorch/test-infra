import {
  Box,
  ButtonBase,
  Checkbox,
  InputBase,
  Typography,
  useTheme,
} from "@mui/material";
import CostFrame from "components/tests/cost/CostFrame";
import { ScopeKeys } from "components/tests/cost/OwnerChart";
import type { WorkflowPreset } from "lib/api/tests/cost/types";
import { otherMachinesColor, paleColor } from "lib/tests/cost/colors";
import { hoursLabel, shareLabel } from "lib/tests/cost/query";
import {
  type CostView,
  highlightName,
  type PreparedHours,
  scopeName,
  toggled,
  workflowRows,
} from "lib/tests/cost/runnerHours";
import { headerKeyColors, headerKeySx } from "lib/tests/headerColors";
import { HEADER_FILTER_SIZE } from "lib/tests/layout";
import { useState } from "react";

export interface WorkflowsCardProps {
  prepared: PreparedHours;
  view: CostView;
  presets: WorkflowPreset[];
  scope: readonly string[];
  loading: boolean;
  // The days the answer covers, in words.
  dates: string;
  onScopeChange: (_workflows: string[]) => void;
}

// The scope picker: every workflow's runner-hours as a share of the whole
// window, a fixed base, so ticking one never moves the others. The largest
// few are listed, with any ticked one pinned, the rest behind "+ N more"
// and a search. Ticking workflows makes a custom scope; the band's keys pick
// every workflow or a preset. With a highlight, each workflow's highlighted
// hours draw over its bar.
export default function WorkflowsCard({
  prepared,
  view,
  presets,
  scope,
  loading,
  dates,
  onScopeChange,
}: WorkflowsCardProps) {
  const theme = useTheme();
  // Open at first: folded, it was easy to miss.
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const { shown, hidden } = workflowRows(prepared, view, expanded, search);
  const max = Math.max(1, ...Array.from(prepared.workflowTotal));
  const highlighting = view.owners.size > 0 || view.machines.size > 0;
  const keys = (
    <Box sx={{ display: "flex", gap: 0.75, alignItems: "center" }}>
      {expanded && (
        <InputBase
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search workflows"
          inputProps={{ "aria-label": "Search workflows" }}
          sx={{
            height: HEADER_FILTER_SIZE,
            px: 1,
            typography: "body2",
            ...headerKeySx(theme, headerKeyColors(theme)),
          }}
        />
      )}
      <ScopeKeys
        presets={presets}
        scope={scope}
        scopeLabel={scopeName(prepared, view)}
        onScopeChange={onScopeChange}
        showCustom={false}
      />
    </Box>
  );
  return (
    <CostFrame
      title="Workflows"
      description="Each workflow's share of all runner-hours. Ticking workflows scopes the whole page."
      note={`share of all ${hoursLabel(
        prepared.total
      )} runner-hours · ${dates}`}
      keys={keys}
      loading={loading}
      open={open}
      onOpenChange={setOpen}
    >
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
        Most readers can leave this on All workflows; tick some to narrow the
        page
        {highlighting ? (
          <>
            .{" "}
            <Box component="span" sx={{ color: "primary.main" }}>
              Blue
            </Box>
            : {highlightName(prepared, view)}
          </>
        ) : (
          ""
        )}
        .
      </Typography>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: {
            xs: "minmax(0, 1fr)",
            md: "repeat(2, minmax(0, 1fr))",
          },
          columnGap: 4,
          typography: "body2",
        }}
      >
        {shown.map((w) => {
          const name = prepared.workflows[w];
          const inScope = view.scope.size === 0 || view.scope.has(w);
          const ticked = view.scope.has(w);
          const hours = prepared.workflowTotal[w];
          const lit = view.workflowHighlighted[w];
          return (
            <Box
              key={name}
              component="label"
              title={`${name}: ${hoursLabel(hours)} runner-hours${
                highlighting ? `; ${hoursLabel(lit)} h highlighted` : ""
              }`}
              sx={{
                display: "grid",
                gridTemplateColumns: "22px minmax(0, 1fr) 120px 40px 64px",
                alignItems: "center",
                columnGap: 1,
                minHeight: 26,
                px: 0.5,
                borderRadius: "4px",
                font: "inherit",
                textAlign: "left",
                cursor: "pointer",
                "&:hover": { backgroundColor: "action.hover" },
              }}
            >
              <Checkbox
                size="small"
                checked={ticked}
                disableRipple
                onChange={() =>
                  onScopeChange(
                    toggled(
                      Array.from(view.scope).map((s) => prepared.workflows[s]),
                      [name]
                    )
                  )
                }
                sx={{ p: 0, "& .MuiSvgIcon-root": { fontSize: 18 } }}
              />
              <Box
                component="span"
                sx={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontWeight: ticked ? 600 : 400,
                }}
              >
                {name}
              </Box>
              <Box component="span" sx={{ position: "relative", height: 8 }}>
                <Box
                  component="span"
                  sx={{
                    position: "absolute",
                    inset: 0,
                    width: `${(100 * hours) / max}%`,
                    borderRadius: "2px",
                    backgroundColor: highlighting
                      ? paleColor(theme)
                      : inScope
                      ? theme.palette.primary.main
                      : otherMachinesColor(theme),
                    opacity: !highlighting && !inScope ? 0.5 : 1,
                  }}
                />
                {highlighting && (
                  <Box
                    component="span"
                    sx={{
                      position: "absolute",
                      inset: 0,
                      width: `${(100 * lit) / max}%`,
                      borderRadius: "2px",
                      backgroundColor: theme.palette.primary.main,
                    }}
                  />
                )}
              </Box>
              <Box
                component="span"
                sx={{
                  color: "text.secondary",
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {shareLabel(hours / (prepared.total || 1))}
              </Box>
              <Box
                component="span"
                sx={{
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                  color: highlighting ? "primary.main" : "text.secondary",
                }}
              >
                {hoursLabel(highlighting ? lit : hours)} h
              </Box>
            </Box>
          );
        })}
      </Box>
      {(hidden > 0 || expanded) && (
        <ButtonBase
          onClick={() => {
            setExpanded(!expanded);
            setSearch("");
          }}
          sx={{
            mt: 1,
            typography: "body2",
            color: "primary.main",
            "&:hover": { textDecoration: "underline" },
            "&.Mui-focusVisible": {
              outline: `2px solid ${theme.palette.primary.main}`,
            },
          }}
        >
          {expanded ? "Show fewer" : `+ ${hidden} more workflows`}
        </ButtonBase>
      )}
    </CostFrame>
  );
}
