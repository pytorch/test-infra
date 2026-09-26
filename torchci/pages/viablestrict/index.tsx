import { MenuItem, Select, Stack, Typography } from "@mui/material";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import LoadingPage from "components/common/LoadingPage";
import dayjs from "dayjs";
import { fetcher } from "lib/GeneralUtils";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";

const REPO = "pytorch/pytorch";

interface ViableStrictRun {
  sha: string;
  message: string;
  author: string;
  timestamp: string;
}

export default function Page() {
  const [days, setDays] = useState(7);

  const url = `/api/clickhouse/viablestrict_runs?parameters=${encodeURIComponent(
    JSON.stringify({ repo: REPO, days })
  )}`;
  const { data, isLoading } = useSWR<ViableStrictRun[]>(url, fetcher, {
    refreshInterval: 5 * 60 * 1000, // 5 min
  });

  const columns: GridColDef[] = [
    {
      field: "sha",
      headerName: "Commit",
      flex: 1,
      renderCell: (params) => (
        <Link href={`/viablestrict/${params.value}`}>
          {(params.value as string).slice(0, 7)}
        </Link>
      ),
    },
    {
      field: "message",
      headerName: "Title",
      flex: 4,
      // Commit messages can be multi-line; show only the first line.
      valueGetter: (value: string) => (value ?? "").split("\n")[0],
    },
    { field: "author", headerName: "Author", flex: 1 },
    {
      field: "timestamp",
      headerName: "Commit time (UTC)",
      flex: 1.5,
      valueGetter: (value: string) =>
        value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "",
    },
    {
      field: "hud",
      headerName: "HUD",
      flex: 0.5,
      sortable: false,
      renderCell: (params) => (
        <Link href={`/hud/pytorch/pytorch/${params.row.sha}`}>view</Link>
      ),
    },
  ];

  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Typography variant="h4">viable/strict commits</Typography>
      <Typography variant="body2" color="text.secondary">
        Each commit the <code>viable/strict</code> branch was advanced to. Click
        a commit to explore all of its tests (pass/fail/skip, duration, retries)
        sorted and filterable.
      </Typography>

      <Stack direction="row" spacing={2} alignItems="center">
        <span>Window:</span>
        <Select
          size="small"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          <MenuItem value={1}>1 day</MenuItem>
          <MenuItem value={3}>3 days</MenuItem>
          <MenuItem value={7}>7 days</MenuItem>
          <MenuItem value={14}>14 days</MenuItem>
          <MenuItem value={30}>30 days</MenuItem>
        </Select>
        <Typography variant="body2" color="text.secondary">
          {data?.length ?? 0} commits
        </Typography>
      </Stack>

      <div style={{ height: "80vh", width: "100%" }}>
        {isLoading ? (
          <LoadingPage />
        ) : (
          <DataGrid
            rows={data ?? []}
            columns={columns}
            density="compact"
            getRowId={(row) => row.sha}
            initialState={{
              sorting: { sortModel: [{ field: "timestamp", sort: "desc" }] },
              pagination: { paginationModel: { pageSize: 50 } },
            }}
            pageSizeOptions={[25, 50, 100]}
          />
        )}
      </div>
    </Stack>
  );
}
