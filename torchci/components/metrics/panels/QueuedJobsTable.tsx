import CloseIcon from "@mui/icons-material/Close";
import { IconButton } from "@mui/material";
import { GridRenderCellParams } from "@mui/x-data-grid";
import { durationDisplay } from "components/common/TimeUtils";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import { fetcher } from "lib/GeneralUtils";
import useSWR from "swr";

export default function QueuedJobsTable({
  machineTypeFilter,
  onClearFilter,
}: {
  machineTypeFilter: string | null;
  onClearFilter: () => void;
}) {
  const url = `/api/clickhouse/queued_jobs?parameters=${encodeURIComponent(
    JSON.stringify({})
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 5 * 60 * 1000, // refresh every 5 minutes
  });

  const filteredData =
    data === undefined
      ? undefined
      : machineTypeFilter
      ? data.filter((row: any) => row.machine_type === machineTypeFilter)
      : data;

  const title = machineTypeFilter ? (
    <span>
      Jobs in Queue (filtered by: {machineTypeFilter}
      <IconButton
        size="small"
        onClick={onClearFilter}
        sx={{ ml: 0.5, p: 0.5 }}
        title="Clear filter"
      >
        <CloseIcon fontSize="small" />
      </IconButton>
      )
    </span>
  ) : (
    "Jobs in Queue"
  );

  return (
    <TablePanelWithData
      title={title}
      data={filteredData}
      columns={[
        {
          field: "queue_s",
          headerName: "Time in Queue",
          flex: 1,
          valueFormatter: (params: number) => durationDisplay(params),
        },
        { field: "machine_type", headerName: "Machine Type", flex: 1 },
        {
          field: "source",
          headerName: "Source",
          flex: 2,
          valueGetter: (value: any, row: any) => {
            const sourceType = row.source_type;
            const ciflowId = row.ciflow_id;
            const sha = row.head_sha?.substring(0, 7) || "";

            if (sourceType === "autorevert") {
              return `autorevert restart ${sha}`;
            } else if (sourceType === "ciflow" && ciflowId) {
              return `ciflow #${ciflowId}`;
            } else if (sourceType === "main") {
              return `main push ${sha}`;
            } else {
              return sha;
            }
          },
          renderCell: (params: GridRenderCellParams<any, any>) => {
            const row = params.row;
            const sha = row.head_sha?.substring(0, 7) || "";
            const fullSha = row.head_sha || "";
            const sourceType = row.source_type;
            const ciflowId = row.ciflow_id;
            const hudCommitUrl = `https://hud.pytorch.org/pytorch/pytorch/commit/${fullSha}`;

            if (sourceType === "autorevert") {
              return (
                <span>
                  autorevert restart{" "}
                  <a
                    href={hudCommitUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {sha}
                  </a>
                </span>
              );
            } else if (sourceType === "ciflow" && ciflowId) {
              // ciflowId is the PR number for ciflow/trunk/* tags
              return (
                <span>
                  ciflow{" "}
                  <a
                    href={`https://github.com/pytorch/pytorch/pull/${ciflowId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    #{ciflowId}
                  </a>
                </span>
              );
            } else if (sourceType === "main") {
              return (
                <span>
                  main push{" "}
                  <a
                    href={hudCommitUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {sha}
                  </a>
                </span>
              );
            } else {
              return (
                <a
                  href={hudCommitUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {sha}
                </a>
              );
            }
          },
        },
        {
          field: "name",
          headerName: "Job Name",
          flex: 4,
          renderCell: (params: GridRenderCellParams<any, string>) => (
            <a href={params.row.html_url}>{params.value}</a>
          ),
        },
        { field: "html_url" },
        { field: "head_sha" },
        { field: "head_branch" },
        { field: "event" },
        { field: "source_type" },
        { field: "ciflow_id" },
      ]}
      dataGridProps={{
        columnVisibilityModel: {
          html_url: false,
          head_sha: false,
          head_branch: false,
          event: false,
          source_type: false,
          ciflow_id: false,
        },
        getRowId: (el: any) => el.html_url,
      }}
    />
  );
}
