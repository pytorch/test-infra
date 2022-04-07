import useSWR from "swr";
import { DataGrid, DataGridProps, GridColDef } from "@mui/x-data-grid";
import { Typography, Skeleton } from "@mui/material";
import { RocksetParam } from "lib/rockset";

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
}: {
  title: string;
  queryCollection?: string;
  queryName: string;
  queryParams: RocksetParam[];
  columns: GridColDef[];
  dataGridProps: any;
}) {
  const url = `/api/metrics/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 5 * 60 * 1000, // refresh every 5 minutes
  });

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  function Header() {
    return (
      <Typography fontSize="16px" fontWeight="700" sx={{ p: 1 }}>
        {title}
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
