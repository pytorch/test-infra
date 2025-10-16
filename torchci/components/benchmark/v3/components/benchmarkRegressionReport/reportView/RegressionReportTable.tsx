import CloseIcon from "@mui/icons-material/Close";
import { Drawer, IconButton, Tooltip, Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import { useCallback, useState } from "react";
import {
  GroupInfoChips,
  ReportPageToV3MainPageNavigationButton,
} from "../common";
import { ReportTimeSereisChartSection } from "./RegressionReportTimeSeriesChart";

export default function RegressionReportTable({
  data,
  title,
  report_id,
  enableSidePanel = true,
}: {
  data: any[];
  title: string;
  report_id: string;
  enableSidePanel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<any | null>(null);

  const handleRowClick = useCallback((params: any) => {
    if (!enableSidePanel) return;

    setCurrent(params.row?._raw ?? null);
    setOpen(true);
  }, []);

  const closePanel = () => {
    setOpen(false);
    setCurrent(null);
  };

  // Build rows by flattening group_info
  const rows = data.map((item, i) => {
    const points = item.points ?? [];
    const latest = points.length > 0 ? points[points.length - 1] : null;
    return {
      id: i,
      _raw: item,
      baseline_vs_latest: `${item.baseline_point?.value} -> ${latest?.value}`,
      baseline_commit: item.baseline_point?.commit?.slice(0, 7) ?? "",
      latest_commit: latest?.commit?.slice(0, 7) ?? "",
    };
  });

  // Add group info for metadata
  const metaCol: GridColDef = {
    field: "group",
    headerName: "Labels",
    renderCell: ({ row }) => {
      const info = row._raw?.group_info ?? {};
      const text = Object.entries(info)
        .map(([k, v]) => `${k}:${v}`)
        .join(" • "); // separator between pairs
      return (
        <Tooltip
          title={
            <>
              <GroupInfoChips info={info} />
            </>
          }
        >
          <Typography
            variant="body2"
            sx={{
              minWidth: 200,
              whiteSpace: "normal", // allow wrapping
              wordBreak: "break-word", // break long words if needed
            }}
          >
            {text}
          </Typography>
        </Tooltip>
      );
    },
  };
  // Add navigate column
  const navigateCol: GridColDef = {
    field: "__actions",
    headerName: "Main page",
    sortable: false,
    filterable: false,
    align: "center",
    renderCell: ({ row }) => {
      return (
        <ReportPageToV3MainPageNavigationButton
          group_info={row._raw?.group_info}
          report_id={report_id}
          startCommit={row._raw?.baseline_point}
          endCommit={row._raw?.points[row._raw?.points.length - 1]}
        />
      );
    },
  };

  // Add extra static columns
  const mainCols: GridColDef[] = [
    { minWidth: 50, ...navigateCol },
    {
      field: "baseline_vs_latest",
      headerName: "Compare",
      minWidth: 80,
      flex: 1,
    },
    {
      field: "baseline_commit",
      headerName: "Baseline Commit",
      minWidth: 80,
      flex: 2,
    },
    {
      field: "latest_commit",
      minWidth: 80,
      flex: 3,
      headerName: "Last Regression Commit",
    },
    { flex: 4, ...metaCol },
  ];
  const columns: GridColDef[] = mainCols;
  return (
    <Box sx={{ width: "100%" }}>
      <Typography variant="h6" sx={{ mb: 1 }}>
        {title}
      </Typography>
      <DataGrid
        rowHeight={70}
        rows={rows}
        columns={columns}
        disableRowSelectionOnClick={enableSidePanel}
        onRowClick={(params) => handleRowClick(params)}
        sx={{
          cursor: "pointer",
          "& .MuiDataGrid-row": {
            color: (theme) =>
              enableSidePanel ? theme.palette.primary.main : "default",
          },
          "& .MuiDataGrid-row:hover": {
            backgroundColor: (theme) => theme.palette.action.hover,
          },
          "& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within": {
            outline: "none",
          },
        }}
      />
      <Drawer anchor="right" open={open} onClose={closePanel}>
        <Stack direction="row" alignItems="center" sx={{ p: 2 }}>
          <IconButton onClick={closePanel} aria-label="Close">
            <CloseIcon />
          </IconButton>
          <Typography variant="h6">Details</Typography>
        </Stack>
        {current && (
          <ReportTimeSereisChartSection
            data={current}
            subtitle={"Chart"}
            enableIndicator={true}
            report_id={report_id}
          />
        )}
      </Drawer>
    </Box>
  );
}
