import HelpIcon from "@mui/icons-material/Help";
import { Skeleton, Typography } from "@mui/material";
import IconButton from "@mui/material/IconButton";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import { CSSProperties } from "react";
import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export default function TablePanel({
  // Human-readable title for this panel.
  title,
  // Query name
  queryName,
  // Params to pass to the query.
  queryParams,
  // Column definitions for the data grid.
  columns,
  // Props to propagate to the data grid.
  dataGridProps,
  // An optional help link to display in the title
  helpLink,
  // An optional flag to show the table footer
  showFooter,
}: {
  title: string;
  queryName: string;
  queryParams: { [key: string]: any };
  columns: GridColDef[];
  dataGridProps: any;
  helpLink?: string;
  showFooter?: boolean;
}) {
  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 5 * 60 * 1000, // refresh every 5 minutes
  });

  return (
    <TablePanelWithData
      title={title}
      data={data}
      columns={columns}
      dataGridProps={dataGridProps}
      helpLink={helpLink}
      showFooter={showFooter}
    />
  );
}

export function TablePanelWithData({
  // Human-readable title for this panel.
  title,
  // The raw data to display in the table
  data,
  // Column definitions for the data grid.
  columns,
  // Props to propagate to the data grid.
  dataGridProps,
  // An optional help link to display in the title
  helpLink,
  // An optional flag to show the table footer
  showFooter,
  pageSize,
  disableAutoPageSize,
  customStyle,
}: {
  title: string;
  data: any;
  columns: GridColDef[];
  dataGridProps: any;
  helpLink?: string;
  showFooter?: boolean;
  disableAutoPageSize?: boolean;
  customStyle?: CSSProperties;
  pageSize?: number;
}) {
  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  function helpLinkOnClick() {
    window.open(helpLink, "_blank");
  }

  function Header() {
    return (
      <Typography fontSize="16px" fontWeight="700" sx={{ p: 1 }}>
        {title}{" "}
        {helpLink !== undefined && (
          <IconButton size="small" onClick={helpLinkOnClick}>
            <HelpIcon fontSize="inherit" color="info" />
          </IconButton>
        )}
      </Typography>
    );
  }

  return (
    <>
      <DataGrid
        style={customStyle}
        {...dataGridProps}
        density={"compact"}
        rows={data}
        columns={columns}
        hideFooter={!showFooter}
        autoPageSize={
          showFooter && pageSize === undefined && !disableAutoPageSize
        }
        pageSize={pageSize}
        slots={{ toolbar: Header }}
      />
    </>
  );
}
