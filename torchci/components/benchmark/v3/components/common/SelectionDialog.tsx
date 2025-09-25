import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
} from "@mui/material";

import { Typography } from "@mui/material";
import { resolveComponent } from "../../configs/configRegistration";
import { RawTimeSeriesPoint } from "../dataRender/components/benchmarkTimeSeries/helper";

export interface TimeSeriesChartDialogContentProps {
  leftMeta: RawTimeSeriesPoint | null;
  rightMeta: RawTimeSeriesPoint | null;
  other?: any;
  triggerUpdate: () => void;
  closeDialog: () => void;
}

type SelectionDialogProps = {
  open: boolean;
  onClose: () => void;
  leftMeta: any;
  rightMeta: any;
  other?: Record<string, any>;
  onSelect?: () => void;
  config?: any;
  enabled?: boolean;
};

export function SelectionDialog({
  open,
  onClose,
  leftMeta,
  rightMeta,
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
      <DialogTitle>Selection Confirmed</DialogTitle>
      <DialogContent dividers>
        <DialogContentComponent
          leftMeta={leftMeta}
          rightMeta={rightMeta}
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
  leftMeta,
  rightMeta,
  other,
  closeDialog,
  triggerUpdate,
}: TimeSeriesChartDialogContentProps): React.ReactNode {
  return (
    <>
      <Typography variant="body1" gutterBottom>
        Left Selection:
      </Typography>
      {leftMeta ? (
        <pre>{JSON.stringify(leftMeta, null, 2)}</pre>
      ) : (
        <em>None</em>
      )}

      <Typography variant="body1" gutterBottom sx={{ mt: 2 }}>
        Right Selection:
      </Typography>
      {rightMeta ? (
        <pre>{JSON.stringify(rightMeta, null, 2)}</pre>
      ) : (
        <em>None</em>
      )}
    </>
  );
}
