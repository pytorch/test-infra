import { Pagination, Stack, Tooltip } from "@mui/material";
import { DataGrid, GridColDef } from "@mui/x-data-grid";
import LoadingPage from "components/LoadingPage";
import TestSearchForm from "components/tests/TestSearchForm";
import { encodeParams } from "lib/GeneralUtils";
import { useRouter } from "next/router";
import { ListTestInfoAPIResponse } from "pages/api/flaky-tests/search";
import { useEffect, useState } from "react";
import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export default function Page() {
  const router = useRouter();
  const name = (router.query.name || "") as string;
  const suite = (router.query.suite || "") as string;
  const file = (router.query.file || "") as string;
  const [page, setPage] = useState(1);
  const [count, setCount] = useState(1);
  const { data, isLoading } = useSWR<ListTestInfoAPIResponse>(
    `/api/flaky-tests/search?${encodeParams({
      name,
      suite,
      file,
      per_page: "100",
      page: page.toString(),
    })}`,
    fetcher
  );

  const columns: GridColDef[] = [
    {
      field: "name",
      headerName: "Name",
      flex: 2,
      renderCell: (params) => {
        return (
          <Tooltip title={params.value}>
            <a
              href={`/tests/testInfo?${encodeParams({
                name: params.value,
                suite: params.row.classname,
                file: params.row.file,
              })}`}
            >
              {params.value}
            </a>
          </Tooltip>
        );
      },
    },
    { field: "classname", headerName: "Classname", flex: 1 },
    { field: "file", headerName: "File", flex: 1 },
    { field: "invoking_file", headerName: "Invoking File", flex: 1 },
    { field: "last_run", headerName: "Last Run", flex: 1 },
  ];

  useEffect(() => {
    if (data) {
      setCount(Math.ceil(data.count / 100));
    }
  }, [data]);

  if (!router.isReady) {
    // router.query is not set on the initial render, so I return this in order
    // to force the entire component to re-render once the query is set.  This
    // gets around the TextField defaultValue getting set to "" and then not
    // changing when the router changes.  Another option could be setting state
    // but that is a lot of variables to set
    return <LoadingPage />;
  }

  return (
    <Stack spacing={{ xs: 1 }}>
      <h1>Test Search</h1>
      <TestSearchForm name={name} suite={suite} file={file} />
      <Pagination
        count={count}
        page={page}
        onChange={(_e, value) => setPage(value)}
      />
      <div style={{ height: "600px", width: "100%" }}>
        {isLoading ? (
          <LoadingPage />
        ) : (
          <DataGrid
            sx={{ "&:last-child td, &:last-child th": { border: 0 } }}
            rows={data?.tests || []}
            columns={columns}
            density={"compact"}
            hideFooter={true}
            getRowId={(row) =>
              `${row.name}-${row.classname}-${row.file}-${row.invoking_file}`
            }
            pagination={undefined}
          />
        )}
      </div>
    </Stack>
  );
}
