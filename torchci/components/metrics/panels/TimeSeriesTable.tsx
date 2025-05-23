/**
 * A metrics panel that shows time series data in a table format.
 */
import { Paper } from "@mui/material";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import { formatTimeForCharts } from "components/TimeUtils";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { fetcher } from "lib/GeneralUtils";
import { useMemo } from "react";
import useSWR from "swr";
import {
  ChartType,
  Granularity,
  seriesWithInterpolatedTimes,
} from "./TimeSeriesPanel";

dayjs.extend(utc);

export default function TimeSeriesTable({
  // Human-readable title of the panel.
  title,
  // Query name
  queryName,
  // Query parameters
  queryParams,
  // Granularity of the time buckets.
  granularity,
  // What field name to group by. Each unique value in this field will show up
  // as its own column.
  groupByFieldName,
  // What field name to treat as the time value.
  timeFieldName,
  // Display format for the time field (ex "M/D h:mm:ss A")
  timeFieldDisplayFormat = "M/D (UTC)",
  // What field name to put on the data cells.
  yAxisFieldName,
  // Callback to render the cell value in some nice way.
  yAxisRenderer,
  // Chart type (used for generating series data)
  chartType = "line",
  // Sort by total or name
  sort_by = "name",
  // Max items to show (the rest will be grouped as "Other")
  max_items_in_series = 0,
  // Filter string to limit displayed series
  filter = undefined,
  // Whether filter is regex
  isRegex = false,
  // Whether to auto-refresh
  auto_refresh = true,
  // Additional function to process the data after querying
  dataReader = undefined,
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
  max_items_in_series?: number;
  filter?: string;
  isRegex?: boolean;
  auto_refresh?: boolean;
  dataReader?: (_data: { [k: string]: any }[]) => { [k: string]: any }[];
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
      s.data.forEach((point: [string, number]) => {
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
          renderCell: (params) => <div>{yAxisRenderer(params.value)}</div>,
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
        const point = s.data.find((d: [string, any]) => d[0] === timestamp);
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

  return (
    <Paper sx={{ p: 2 }} elevation={3}>
      <div style={{ width: "100%" }}>
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
            width: "100%",
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
