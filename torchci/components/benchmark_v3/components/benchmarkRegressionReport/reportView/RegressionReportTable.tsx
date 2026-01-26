import CloseIcon from "@mui/icons-material/Close";
import { Drawer, IconButton, Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import { useCallback, useMemo, useState } from "react";
import { ReportPageToV3MainPageNavigationButton } from "../common";
import { ReportTimeSereisChartSection } from "./RegressionReportTimeSeriesChart";

export default function RegressionReportTable({
  data,
  title,
  report_id,
  enableSidePanel = true,
}: {
  data: any[];
  title?: string;
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
  const allUniqueGroupInfo = useMemo(() => {
    const map = new Map<string, Set<string>>();
    rows.forEach((row) => {
      const info = row._raw?.group_info ?? {};
      Object.entries(info).forEach(([key, value]) => {
        if (value === "" || value === null || value === undefined) {
          return; // skip empty values
        }

        if (!map.has(key)) {
          map.set(key, new Set<string>());
        }
        map.get(key)!.add(String(value));
      });
    });
    // Remove keys that collected no valid values
    for (const [key, set] of map.entries()) {
      if (set.size === 0) {
        map.delete(key);
      }
    }
    return map;
  }, [rows]);

  const metaCols: GridColDef[] = useMemo(() => {
    return Array.from(allUniqueGroupInfo.keys())
      .map(
        (groupKey): GridColDef => ({
          field: groupKey,
          headerName: groupKey,
          sortable: true,
          filterable: true,
          flex: 1,
          valueGetter: (_value: any, row: any) => {
            return row._raw?.group_info?.[groupKey] ?? "";
          },
          renderCell: ({ row }) => {
            const value = row._raw?.group_info?.[groupKey] ?? "";
            return (
              <Typography
                variant="body2"
                sx={{
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                }}
              >
                {value}
              </Typography>
            );
          },
        })
      )
      .sort((a, b) => {
        const A = a.headerName ?? a.field;
        const B = b.headerName ?? b.field;
        return A.localeCompare(B);
      });
  }, [allUniqueGroupInfo]);
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
      flex: 1,
    },
    {
      field: "baseline_commit",
      headerName: "Baseline Commit",
      flex: 1,
    },
    {
      field: "latest_commit",
      flex: 1,
      headerName: "Last Regression Commit",
    },
    ...metaCols,
  ];

  const columns: GridColDef[] = mainCols;
  return (
    <Box sx={{ width: "100%" }}>
      {title && (
        <Typography variant="h6" sx={{ mb: 1 }}>
          {title}
        </Typography>
      )}
      <DataGrid
        rows={rows}
        columns={columns}
        disableRowSelectionOnClick={enableSidePanel}
        onRowClick={(params) => handleRowClick(params)}
        initialState={{
          pagination: {
            paginationModel: {
              pageSize: 25,
              page: 0,
            },
          },
        }}
        pageSizeOptions={[25, 50, 100]}
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
