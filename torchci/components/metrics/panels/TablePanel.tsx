import useSWR from "swr";
import { DataGrid, DataGridProps, GridColDef } from "@mui/x-data-grid";
import { Typography, Skeleton } from "@mui/material";
import { RocksetParam } from "lib/rockset";
import HelpIcon from "@mui/icons-material/Help";
import IconButton from "@mui/material/IconButton";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export default function TablePanel({
  // Human-readable title for this panel.
  title,
  // Query lambda collection in Rockset.
  queryCollection = "metrics",
  // Query lambda name in Rockset, ("metrics" collection is assumed).
  queryName,
  // Params to pass to the Rockset query.
  queryParams,
  // Column definitions for the data grid.
  columns,
  // Props to propagate to the data grid.
  dataGridProps,
  // An optional help link to display in the title
  helpLink,
}: {
  title: string;
  queryCollection?: string;
  queryName: string;
  queryParams: RocksetParam[];
  columns: GridColDef[];
  dataGridProps: any;
  helpLink?: string;
}) {
  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
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
}: {
  title: string;
  data: any;
  columns: GridColDef[];
  dataGridProps: any;
  helpLink?: string;
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
    <DataGrid
      {...dataGridProps}
      density={"compact"}
      rows={data}
      columns={columns}
      hideFooter
      components={{
        Toolbar: Header,
      }}
    />
  );
}
