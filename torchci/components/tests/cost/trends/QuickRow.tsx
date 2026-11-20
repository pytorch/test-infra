import { Box, ButtonBase, Tooltip, Typography, useTheme } from "@mui/material";
import type { ComparePreset } from "lib/api/tests/cost/contracts";
import type { PresetChoice } from "lib/tests/cost/select";

export interface QuickRowProps {
  presets: PresetChoice[];
  active: ComparePreset | null;
  onPreset(_id: ComparePreset): void;
}

// The quick presets: each sets the rollup, A and B. A preset without data
// for every day of A and B is off, its one-line tooltip naming the days it
// needs.
export default function QuickRow({ presets, active, onPreset }: QuickRowProps) {
  const theme = useTheme();
  return (
    <Box
      sx={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 0.75,
      }}
    >
      <Typography
        variant="body2"
        sx={{ color: "text.secondary", minWidth: 40, mr: 0.25 }}
      >
        Quick
      </Typography>
      {presets.map((p) => {
        const on = active === p.id;
        return (
          <Tooltip key={p.id} title={p.title} enterDelay={600}>
            <ButtonBase
              aria-pressed={on}
              aria-disabled={!p.available || undefined}
              onClick={p.available ? () => onPreset(p.id) : undefined}
              sx={{
                height: 26,
                px: 1.25,
                borderRadius: "13px",
                typography: "body2",
                whiteSpace: "nowrap",
                border: `1px solid ${
                  on ? theme.palette.primary.main : theme.palette.divider
                }`,
                backgroundColor: on
                  ? theme.palette.primary.main
                  : "transparent",
                color: on
                  ? theme.palette.primary.contrastText
                  : theme.palette.text.primary,
                opacity: p.available ? 1 : 0.45,
                cursor: p.available ? "pointer" : "default",
                "&:hover":
                  p.available && !on
                    ? { borderColor: theme.palette.text.secondary }
                    : {},
                "&.Mui-focusVisible": {
                  outline: `2px solid ${theme.palette.primary.main}`,
                },
              }}
            >
              {p.label}
            </ButtonBase>
          </Tooltip>
        );
      })}
    </Box>
  );
}
