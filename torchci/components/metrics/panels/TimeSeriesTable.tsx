/**
 * A metrics panel that shows time series data in a table format.
 */
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import { IconButton, Paper, Stack, Tooltip } from "@mui/material";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import { formatTimeForCharts } from "components/TimeUtils";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { fetcher } from "lib/GeneralUtils";
import { arrayToCSV, downloadCSV } from "lib/csvUtils";
import { useMemo } from "react";
import useSWR from "swr";
import {
  ChartType,
  Granularity,
  seriesWithInterpolatedTimes,
} from "./TimeSeriesPanel";

dayjs.extend(utc);

export default function TimeSeriesTable({
  title,
  queryName,
  queryParams,
  granularity,
  groupByFieldName,
  timeFieldName,
  timeFieldDisplayFormat = "M/D (UTC)",
  yAxisFieldName,
  yAxisRenderer,
  chartType = "line",
  sort_by = "name",
  filter = undefined,
  isRegex = false,
  auto_refresh = true,
  dataReader = undefined,
  defaultOptions = {},
}: {
  title: string;
  queryName: string;
  queryParams: { [key: string]: any };
  granularity: Granularity;
  groupByFieldName?: string;
  timeFieldName: string;
  timeFieldDisplayFormat?: string;
  yAxisFieldName: string;
  yAxisRenderer: (_value: any) => string;
  chartType?: ChartType;
  sort_by?: "total" | "name";
  filter?: string;
  isRegex?: boolean;
  auto_refresh?: boolean;
  dataReader?: (_data: { [k: string]: any }[]) => { [k: string]: any }[];
  defaultOptions?: { [key: string]: string[] };
}) {
  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify({
      ...queryParams,
      granularity: granularity as string,
    })
  )}`;

  const { data: rawData, isLoading } = useSWR(url, fetcher, {
    refreshInterval: auto_refresh ? 5 * 60 * 1000 : 0,
  });

  // Process data for table display - transposed version (dates as columns, series as rows)
  const { tableData, columns } = useMemo(() => {
    if (!rawData || isLoading) {
      return { tableData: [], columns: [] };
    }

    const data = dataReader ? dataReader(rawData) : rawData;
    let startTime = dayjs.utc(queryParams["startTime"]);
    let stopTime = dayjs.utc(queryParams["stopTime"]);

    // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
    // align with the data we get from the database
    startTime = startTime.startOf(granularity);
    stopTime = stopTime.endOf(granularity);

    // Get series data using same function as chart
    const series = seriesWithInterpolatedTimes(
      data,
      startTime,
      stopTime,
      granularity,
      groupByFieldName,
      timeFieldName,
      yAxisFieldName,
      true,
      false, // Smooth doesn't apply to table
      sort_by,
      chartType,
      filter,
      isRegex
    );

    // Process series into table data
    // First, we need to get all timestamps
    const allTimestamps = new Set<string>();
    series.forEach((s) => {
      s.data.forEach((point: any) => {
        allTimestamps.add(point[0]);
      });
    });

    // Sort timestamps chronologically
    const timestamps = Array.from(allTimestamps).sort();

    // TRANSPOSED: Create columns with timestamps as headers
    const columns: GridColDef[] = [
      {
        field: "seriesName",
        headerName: "Series",
        width: 250,
        headerClassName: "first-column-header",
        cellClassName: "first-column-cell",
      },
      ...timestamps.map((timestamp) => {
        const formattedTime = formatTimeForCharts(
          timestamp,
          timeFieldDisplayFormat
        );
        return {
          field: timestamp,
          headerName: formattedTime,
          width: 120,
          renderCell: (params: any) => <div>{yAxisRenderer(params.value)}</div>,
        };
      }),
    ];

    // TRANSPOSED: Create rows with series as rows and timestamps as columns
    const tableData = series.map((s, index) => {
      const row: any = {
        id: s.name,
        seriesName: s.name,
      };

      // Add value for each timestamp
      timestamps.forEach((timestamp) => {
        const point = s.data.find((d: any) => d[0] === timestamp);
        row[timestamp] = point ? point[1] : 0;
      });

      return row;
    });

    return { tableData, columns };
  }, [
    rawData,
    isLoading,
    queryParams,
    granularity,
    groupByFieldName,
    timeFieldName,
    yAxisFieldName,
    sort_by,
    chartType,
    filter,
    isRegex,
    yAxisRenderer,
    timeFieldDisplayFormat,
    dataReader,
  ]);

  // Helper function to format data for clipboard (tab-separated for Excel)
  const formatForClipboard = (data: any[], columns: GridColDef[]) => {
    const headers = columns
      .map((col) => col.headerName || col.field)
      .join("\t");
    const rows = data.map((row) =>
      columns
        .map((col) => {
          const value = row[col.field];
          return String(value);
        })
        .join("\t")
    );
    return [headers, ...rows].join("\n");
  };


  // Copy to clipboard handler
  const handleCopyToClipboard = async () => {
    try {
      const clipboardData = formatForClipboard(tableData, columns);
      await navigator.clipboard.writeText(clipboardData);
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
    }
  };

  // Generate filename for CSV export
  const generateFilename = () => {
    // Build filename components
    const startDate = dayjs.utc(queryParams["startTime"]).format("YYYY-MM-DD");
    const endDate = dayjs.utc(queryParams["stopTime"]).format("YYYY-MM-DD");
    const groupBy =
      groupByFieldName?.replace(/[^a-z0-9]/gi, "_") || "ungrouped";

    // Determine metric type from query name or title
    const metricType =
      queryName.includes("cost") || title.toLowerCase().includes("cost")
        ? "cost"
        : "duration";

    // Collect non-default parameters
    const nonDefaultParams = [];

    // Only check parameters that correspond to defaultOptions (skip repos and other params)
    Object.keys(defaultOptions).forEach((optionKey) => {
      // Find matching query parameter key
      const matchingQueryKey = Object.keys(queryParams).find(
        (key) =>
          key.toLowerCase().includes(optionKey.toLowerCase()) &&
          key !== "startTime" &&
          key !== "stopTime" &&
          key !== "granularity"
      );

      if (matchingQueryKey) {
        const value = queryParams[matchingQueryKey];

        // Skip if empty or "all"
        if (
          !value ||
          String(value).trim() === "" ||
          String(value).toLowerCase() === "all"
        ) {
          return;
        }

        const valueStr = String(value);
        const valueArray = valueStr.includes(",")
          ? valueStr.split(",")
          : [valueStr];

        // Only add if not all options are selected
        if (valueArray.length !== defaultOptions[optionKey].length) {
          // Transform GPU values for filename
          let filenameValue = valueStr;
          if (optionKey.toLowerCase() === "gpu") {
            filenameValue = filenameValue
              .replace(/1/g, "withGPU")
              .replace(/0/g, "withoutGPU");
          }
          nonDefaultParams.push(
            `${matchingQueryKey}_${filenameValue.replace(/[^a-z0-9]/gi, "_")}`
          );
        }
      }
    });

    // Add filter if present
    if (filter && filter.trim()) {
      nonDefaultParams.push(`filter_${filter.replace(/[^a-z0-9]/gi, "_")}`);
    }

    // Build filename: pytorchci_{cost|duration}_YYYY-MM-DD_YYYY-MM-DD_groupby_{group}_{params}
    const paramsSuffix =
      nonDefaultParams.length > 0 ? `_${nonDefaultParams.join("_")}` : "";
    return `pytorchci_${metricType}_${startDate}_${endDate}_groupby_${groupBy}${paramsSuffix}.csv`;
  };

  // Export CSV handler
  const handleExportCSV = () => {
    // Convert table data to format expected by arrayToCSV
    const headers = columns.map((col) => col.headerName || col.field);
    const rows = tableData.map((row) => {
      const csvRow: Record<string, any> = {};
      columns.forEach((col) => {
        csvRow[col.headerName || col.field] = row[col.field];
      });
      return csvRow;
    });
    
    const csvData = arrayToCSV(rows, headers);
    const filename = generateFilename();
    downloadCSV(csvData, filename);
  };

  return (
    <Paper sx={{ p: 2 }} elevation={3}>
      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        <Tooltip title="Copy table data to clipboard (Excel-pastable format)">
          <span>
            <IconButton
              size="small"
              sx={{ color: "black" }}
              onClick={handleCopyToClipboard}
              disabled={tableData.length === 0}
            >
              <ContentCopyIcon fontSize="inherit" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Export table data as CSV file">
          <span>
            <IconButton
              size="small"
              sx={{ color: "black" }}
              onClick={handleExportCSV}
              disabled={tableData.length === 0}
            >
              <FileDownloadIcon fontSize="inherit" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      <div style={{ width: "auto", overflowX: "auto" }}>
        <DataGrid
          rows={tableData}
          columns={columns}
          density="compact"
          pageSizeOptions={[25, 50, 100]}
          columnVisibilityModel={{
            // Ensure all columns are visible by default
            timestamp: true,
          }}
          initialState={{
            pagination: {
              paginationModel: { pageSize: 25 },
            },
          }}
          loading={isLoading}
          autoHeight
          sx={{
            width: "fit-content",
            maxWidth: "100%",
            "& .MuiDataGrid-columnHeaders": {
              backgroundColor:
                "#2f847c" /* Blueish-green to match common chart colors */,
              color: "#ffffff",
              fontWeight: "bold",
            },
            "& .MuiDataGrid-columnHeader": {
              backgroundColor: "#2f847c",
              color: "#ffffff",
            },
            "&.MuiDataGrid-root--densityCompact .MuiDataGrid-cell": {
              py: "8px",
            },
            "& .MuiDataGrid-columnHeaderTitle": {
              fontWeight: "bold",
            },
            // Alternating row colors
            "& .MuiDataGrid-row:nth-of-type(odd)": {
              backgroundColor: "rgba(0, 0, 0, 0.04)",
            },
            // First column styling
            "& .first-column-header": {
              backgroundColor: "#1a635d" /* Darker shade for emphasis */,
              color: "#ffffff",
            },
            "& .first-column-cell": {
              backgroundColor: "rgba(47, 132, 124, 0.1)",
              fontWeight: "bold",
            },
          }}
        />
      </div>
    </Paper>
  );
}
