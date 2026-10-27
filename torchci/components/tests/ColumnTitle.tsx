import { Tooltip } from "@mui/material";

export interface ColumnTitleProps {
  // The label, set as the grid sets every header's.
  title: string;
  // What the column shows, for the reader who hovers the label.
  description: string;
}

// A header's label with the column's description as its tooltip: the one
// place that explains a column, so no cell has to. A description's line
// breaks are kept, so one can list what a column's words mean. The label
// keeps the grid's own class and so its style, and a click on it still
// sorts.
export default function ColumnTitle({ title, description }: ColumnTitleProps) {
  return (
    <Tooltip
      title={description}
      enterDelay={600}
      placement="bottom-start"
      slotProps={{ tooltip: { sx: { whiteSpace: "pre-line" } } }}
    >
      <span className="MuiDataGrid-columnHeaderTitle">{title}</span>
    </Tooltip>
  );
}
