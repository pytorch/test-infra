import { Button, FormControlLabel, Switch, Typography } from "@mui/material";
import { Stack } from "@mui/system";
import { SelectionDialog } from "components/benchmark/v3/components/common/SelectionDialog";
import dayjs from "dayjs";
import { useState } from "react";
import { RawTimeSeriesPoint } from "../../helper";

type SelectionControlsProps = {
  selectMode: boolean;
  setSelectMode: (v: boolean) => void;
  left: RawTimeSeriesPoint | null;
  right: RawTimeSeriesPoint | null;
  onClear: () => void;
  onSelect?: () => void;
  confirmDisabled: boolean;
  clearDisabled: boolean;
  customizedConfirmDialog?: any;
};

export const ChartSelectionControl: React.FC<SelectionControlsProps> = ({
  selectMode,
  setSelectMode,
  left,
  right,
  onClear,
  onSelect = () => {},
  confirmDisabled,
  clearDisabled,
  customizedConfirmDialog,
}) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const openDialog = () => {
    setDialogOpen(true);
  };

  return (
    <>
      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        sx={{ mt: 1, flexWrap: "wrap" }}
      >
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={selectMode}
              onChange={(e) => setSelectMode(e.target.checked)}
            />
          }
          label="Select mode"
        />
        <Typography variant="body2" sx={{ ml: 2 }}>
          L:&nbsp;
          {left ? (
            <>
              {dayjs.utc(left.granularity_bucket).format("MM-DD HH:mm")} ·{" "}
              <code>{left.commit.slice(0, 7)}</code>
            </>
          ) : (
            <em>—</em>
          )}
        </Typography>

        <Typography variant="body2" sx={{ ml: 2 }}>
          R:&nbsp;
          {right ? (
            <>
              {dayjs.utc(right.granularity_bucket).format("MM-DD HH:mm")} ·{" "}
              <code>{right.commit.slice(0, 7)}</code>
            </>
          ) : (
            <em>—</em>
          )}
        </Typography>

        <Stack direction="row" spacing={1} sx={{ ml: "auto" }}>
          <Button
            variant="outlined"
            size="small"
            onClick={onClear}
            disabled={clearDisabled}
          >
            Clear
          </Button>
          <Button
            variant="contained"
            size="small"
            onClick={openDialog}
            disabled={confirmDisabled}
          >
            Confirm
          </Button>
        </Stack>
      </Stack>
      {/* Dialog */}
      <SelectionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        other={{ parent: "timeSeriesChart" }}
        left={left}
        right={right}
        onSelect={() => {
          onSelect();
        }}
        enabled={true}
        config={customizedConfirmDialog}
      />
    </>
  );
};
