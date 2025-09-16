import { Button, FormControlLabel, Switch, Typography } from "@mui/material";
import { Stack } from "@mui/system";
import dayjs from "dayjs";
import { RawTimeSeriesPoint } from "../../helper";

type SelectionControlsProps = {
  selectMode: boolean;
  setSelectMode: (v: boolean) => void;

  leftMeta: RawTimeSeriesPoint | null;
  rightMeta: RawTimeSeriesPoint | null;

  onClear: () => void;
  onConfirm: () => void;

  confirmDisabled: boolean;
  clearDisabled: boolean;
};

export const ChartSelectionControl: React.FC<SelectionControlsProps> = ({
  selectMode,
  setSelectMode,
  leftMeta,
  rightMeta,
  onClear,
  onConfirm,
  confirmDisabled,
  clearDisabled,
}) => {
  return (
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
        {leftMeta ? (
          <>
            {dayjs.utc(leftMeta.granularity_bucket).format("MM-DD HH:mm")} ·{" "}
            <code>{leftMeta.commit.slice(0, 7)}</code>
          </>
        ) : (
          <em>—</em>
        )}
      </Typography>

      <Typography variant="body2" sx={{ ml: 2 }}>
        R:&nbsp;
        {rightMeta ? (
          <>
            {dayjs.utc(rightMeta.granularity_bucket).format("MM-DD HH:mm")} ·{" "}
            <code>{rightMeta.commit.slice(0, 7)}</code>
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
          onClick={onConfirm}
          disabled={confirmDisabled}
        >
          Confirm
        </Button>
      </Stack>
    </Stack>
  );
};
