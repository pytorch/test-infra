import CloseIcon from "@mui/icons-material/Close";
import { IconButton } from "@mui/material";
import { GridRenderCellParams } from "@mui/x-data-grid";
import { durationDisplay } from "components/common/TimeUtils";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import { fetcher } from "lib/GeneralUtils";
import useSWR from "swr";

// Shared with QueuedJobsByMachineTypeTable so the summary and the job list it
// drills into always cover the same repos. repo = "" means every repo in org.
export const QUEUED_JOBS_SCOPE = { org: "pytorch", repo: "" };

export default function QueuedJobsTable({
  machineTypeFilter,
  onClearFilter,
}: {
  machineTypeFilter: string | null;
  onClearFilter: () => void;
}) {
  // Every repo in the pytorch org, not only pytorch/pytorch (the query's
  // default, kept for out-of-repo callers of the public endpoint).
  const url = `/api/clickhouse/queued_jobs?parameters=${encodeURIComponent(
    JSON.stringify(QUEUED_JOBS_SCOPE)
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
          valueFormatter: (params: number, row: any) =>
            row.is_stale
              ? `${durationDisplay(params)} (suspected stuck)`
              : durationDisplay(params),
        },
        { field: "machine_type", headerName: "Machine Type", flex: 1 },
        {
          field: "repo",
          headerName: "Repo",
          flex: 1,
          valueFormatter: (value: string) =>
            value?.startsWith(`${QUEUED_JOBS_SCOPE.org}/`)
              ? value.substring(QUEUED_JOBS_SCOPE.org.length + 1)
              : value,
        },
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
            const repo = row.repo || "pytorch/pytorch";
            const hudCommitUrl = `https://hud.pytorch.org/${repo}/commit/${fullSha}`;

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
                    href={`https://github.com/${repo}/pull/${ciflowId}`}
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
        { field: "is_stale" },
      ]}
      dataGridProps={{
        columnVisibilityModel: {
          html_url: false,
          head_sha: false,
          head_branch: false,
          event: false,
          source_type: false,
          ciflow_id: false,
          is_stale: false,
        },
        getRowId: (el: any) => el.html_url,
      }}
    />
  );
}
