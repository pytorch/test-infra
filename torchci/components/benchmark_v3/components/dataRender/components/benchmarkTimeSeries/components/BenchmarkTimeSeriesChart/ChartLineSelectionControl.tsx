import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
} from "@mui/material";
import { RenderRawContent } from "components/benchmark_v3/components/common/RawContentDialog";

export type ChartLineSelectionDialogComponentProps = {
  data: any;
  config: any;
};
export type ChartLineSelectionDialogComponent =
  React.ComponentType<ChartLineSelectionDialogComponentProps>;

type ChartLineSelectDialogProps = {
  onClose: () => void;
  onSelect?: () => void;
  open?: boolean;
  config?: any;
  Component?: ChartLineSelectionDialogComponent;
  data?: any;
};

export const ChartLineSelectDialog: React.FC<ChartLineSelectDialogProps> = ({
  onClose,
  Component,
  config,
  open = false,
  data,
}) => {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{config?.subtitle ?? "Details"}</DialogTitle>
      <DialogContent dividers>
        {Component ? <Component data={data} config={config} /> : null}
        <RenderRawContent data={data} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
};
