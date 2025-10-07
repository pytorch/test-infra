import CloseIcon from "@mui/icons-material/Close";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { Drawer, IconButton, Tooltip, Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import { getBenchmarkIdFromReportId } from "components/benchmark/v3/configs/configBook";
import { getBenchmarkFields } from "components/benchmark/v3/configs/utils/urlHandling";
import { getBenchmarkMainRouteById } from "components/benchmark/v3/pages/BenchmarkListPage";
import { formUrlWithParams } from "components/uiModules/UMCopyLink";
import dayjs from "dayjs";
import {
  BenchmarkCommitMeta,
  TimeRange,
} from "lib/benchmark/store/benchmark_regression_store";
import { useCallback, useState } from "react";
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
        <Typography
          variant="body2"
          sx={{
            minWidth: 150,
          }}
        >
          {text}
        </Typography>
      );
    },
  };
  // Add navigate column
  const navigateCol: GridColDef = {
    field: "__actions",
    headerName: "main page",
    sortable: false,
    filterable: false,
    align: "center",
    renderCell: ({ row }) => {
      const url = getNavigationRoute(
        report_id,
        row._raw?.group_info,
        row._raw?.baseline_point,
        row._raw?.points[row._raw?.points.length - 1]
      );

      return (
        <Tooltip title="Navigate to main page">
          <IconButton
            onClick={(e) => {
              e.stopPropagation();
              console.log("navigate to url", url);
              window.location.href = url; // full reload navigation to avoid werid nextLink issue
            }}
          >
            <OpenInNewIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      );
    },
  };

  // Add extra static columns
  const mainCols: GridColDef[] = [
    { minWidth: 100, ...navigateCol },
    {
      field: "baseline_vs_latest",
      headerName: "Compare",
      minWidth: 110,
      flex: 1,
    },
    {
      field: "baseline_commit",
      headerName: "Baseline Commit",
      minWidth: 110,
      flex: 2,
    },
    {
      field: "latest_commit",
      minWidth: 140,
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
        rows={rows}
        columns={columns}
        disableRowSelectionOnClick
        onRowClick={(params) => handleRowClick(params)}
        sx={{
          cursor: "pointer",
          "& .MuiDataGrid-row": {
            color: (theme) => theme.palette.primary.main,
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
            item={current}
            subtitle={"Chart"}
            enableIndicator={true}
          />
        )}
      </Drawer>
    </Box>
  );
}

// Build url to navigate to main page using report_id
export function getNavigationRoute(
  report_id: string,
  group_info: any,
  baseline: any,
  latest_data: any
): string {
  const id = getBenchmarkIdFromReportId(report_id);
  if (!id) {
    return "";
  }
  const route = getBenchmarkMainRouteById(id);
  if (!route) {
    return "";
  }

  const time: TimeRange = {
    start: dayjs(baseline.timestamp).startOf("day"),
    end: dayjs(latest_data.timestamp).endOf("day"),
  };

  const fields = getBenchmarkFields(group_info, id);

  const lcommit: BenchmarkCommitMeta = {
    commit: baseline.commit,
    branch: baseline.branch,
    workflow_id: baseline.workflow_id,
    date: baseline.timestamp,
  };

  const rcommit: BenchmarkCommitMeta = {
    commit: latest_data.commit,
    branch: latest_data.branch,
    workflow_id: latest_data.workflow_id,
    date: latest_data.timestamp,
  };
  const branch = baseline.branch;

  const params = {
    rcommit: rcommit,
    lcommit: lcommit,
    time: time,
    filters: fields,
    lbranch: branch,
    rbranch: branch,
  };

  const finalRoute = formUrlWithParams(route, params);

  return finalRoute;
}
