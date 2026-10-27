import {
  ButtonBase,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import type { TestView } from "lib/api/tests/options/types";
import { headerBandColor } from "lib/tests/headerColors";
import { useId } from "react";

// The height of a chip in pixels: a line of body2 text and its padding. The
// caption's row keeps this height before the options arrive, so the table
// does not move when the chips appear.
export const VIEW_CHIP_HEIGHT = 26;

export interface ViewChipsProps {
  // The views the options offer, in order.
  views: readonly TestView[];
  // The views the page is showing, usually one or none.
  activeIds: readonly string[];
  onChoose: (_view: TestView) => void;
  // A chosen view's chip was clicked again.
  onClear: (_view: TestView) => void;
}

// The named views as chips after a muted "Starter queries" label, which
// names the group for assistive technology. A chip at rest is the grey of
// the title's pills; the chosen one is filled in the accent color, like a
// header's filter key. A click on a chosen chip clears that view. Each
// chip's description is its tooltip, describing the chip rather than
// replacing its name.
export default function ViewChips({
  views,
  activeIds,
  onChoose,
  onClear,
}: ViewChipsProps) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const labelId = useId();
  if (views.length === 0) {
    return null;
  }
  return (
    <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
      <Typography
        id={labelId}
        variant="body2"
        component="span"
        sx={{ color: "text.secondary", whiteSpace: "nowrap" }}
      >
        Starter queries
      </Typography>
      <Stack
        direction="row"
        role="group"
        aria-labelledby={labelId}
        sx={{ flexWrap: "wrap", gap: 1 }}
      >
        {views.map((view) => {
          const active = activeIds.includes(view.id);
          return (
            <Tooltip
              key={view.id}
              title={view.description}
              enterDelay={600}
              placement="bottom-start"
              describeChild
            >
              <ButtonBase
                aria-pressed={active}
                onClick={() => (active ? onClear(view) : onChoose(view))}
                sx={{
                  ...theme.typography.body2,
                  height: VIEW_CHIP_HEIGHT,
                  px: 1.25,
                  borderRadius: "999px",
                  whiteSpace: "nowrap",
                  color: active
                    ? theme.palette.primary.contrastText
                    : "inherit",
                  backgroundColor: active
                    ? theme.palette.primary.main
                    : headerBandColor(theme),
                  transition: theme.transitions.create("background-color", {
                    duration: theme.transitions.duration.shortest,
                  }),
                  "&:hover": {
                    backgroundColor: active
                      ? theme.palette.primary.dark
                      : dark
                      ? theme.palette.grey[700]
                      : theme.palette.grey[300],
                  },
                  "&.Mui-focusVisible": {
                    outline: `2px solid ${theme.palette.primary.main}`,
                    outlineOffset: 2,
                  },
                }}
              >
                {view.label}
              </ButtonBase>
            </Tooltip>
          );
        })}
      </Stack>
    </Stack>
  );
}
