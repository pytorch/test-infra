import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
} from "@mui/material";

import { Typography } from "@mui/material";
import { RawTimeSeriesPoint } from "../dataRender/components/benchmarkTimeSeries/helper";
import { resolveComponent } from "../../configs/utils/configComponentRegistration";

export interface TimeSeriesChartDialogContentProps {
  left: RawTimeSeriesPoint | null;
  right: RawTimeSeriesPoint | null;
  other?: any;
  triggerUpdate: () => void;
  closeDialog: () => void;
}

type SelectionDialogProps = {
  open: boolean;
  onClose: () => void;
  left: RawTimeSeriesPoint | null;
  right: RawTimeSeriesPoint | null;
  other?: Record<string, any>;
  onSelect?: () => void;
  config?: any;
  enabled?: boolean;
};

export function SelectionDialog({
  open,
  onClose,
  left,
  right,
  other,
  onSelect = () => {},
  config,
  enabled = false,
}: SelectionDialogProps) {
  if (!enabled) {
    return <></>;
  }

  const DialogContentComponent = resolveDialogContentRenderer(config);
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>Choose a destination to navigate</DialogTitle>
      <DialogContent dividers>
        <DialogContentComponent
          left={left}
          right={right}
          other={other}
          closeDialog={onClose}
          triggerUpdate={() => {
            onSelect();
          }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

export function resolveDialogContentRenderer(config?: any) {
  if (!config || config.type != "component")
    return DefaultSelectionDialogContent;

  const key = config.id;
  return (key && resolveComponent(key)) || DefaultSelectionDialogContent;
}

export function DefaultSelectionDialogContent({
  left,
  right,
  other,
  closeDialog,
  triggerUpdate,
}: TimeSeriesChartDialogContentProps): React.ReactNode {
  return (
    <>
      <Typography variant="body1" gutterBottom>
        Left Selection:
      </Typography>
      {left ? <pre>{JSON.stringify(left, null, 2)}</pre> : <em>None</em>}

      <Typography variant="body1" gutterBottom sx={{ mt: 2 }}>
        Right Selection:
      </Typography>
      {right ? <pre>{JSON.stringify(right, null, 2)}</pre> : <em>None</em>}
    </>
  );
}
