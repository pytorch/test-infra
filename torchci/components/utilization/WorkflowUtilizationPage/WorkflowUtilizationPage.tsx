import { Button, styled } from "@mui/material";
import { DataGrid } from "@mui/x-data-grid";
import LoadingPage from "components/LoadingPage";
import SingleValueGauge from "components/utilization/components/SingleValueGauge";
import { fetcher } from "lib/GeneralUtils";
import {
  ListUtilizationMetadataInfoAPIResponse,
  UtilizationMetadataInfo,
} from "lib/utilization/types";
import { useRouter } from "next/router";
import { useEffect } from "react";
import useSWR from "swr";
import { NumericRingChart } from "../components/UtilizationJobSummary/UtilizationJobSummary";
import { computeAverages } from "./hepler";

const MetadataGroupSection = styled("div")({
  display: "flex",
  flexWrap: "wrap",
  minWidth: "550px",
  alignItems: "center",
});

const WorkflowUtilization = () => {
  const router = useRouter();
  const { workflowId } = router.query;
  const data = useUtilMetadata(workflowId as string);

  useEffect(() => {}, [workflowId]);

  if (!data) {
    return <LoadingPage />;
  }

  const statKeys = Array.from(
    new Set(
      data.utilMetadataList.flatMap((job) => Object.keys(job?.stats || {}))
    )
  );

  const rows = data.utilMetadataList.map((job) => {
    const stats = job?.stats || {};
    return {
      id: `${job.job_id}_${job.run_attempt}`,
      name: job.job_name,
      details: `/utilization/${job.workflow_id}/${job.job_id}/${job.run_attempt}`,
      job_id: job.job_id,
      ...stats,
    };
  });

  const columns: any[] = [
    { field: "name", headerName: "Job Name", width: 400 },
    { field: "id", headerName: "Job id", width: 120 },
    {
      field: "details",
      headerName: "details",
      width: 120,
      sortable: false,
      renderCell: (params: any) => {
        return (
          <Button size="small" variant="outlined" href={params.value}>
            Details
          </Button>
        );
      },
    },
    ...statKeys.map((key) => ({
      field: key,
      headerName: key,
      width: 120,
      renderCell: (params: any) => {
        let bgColor = "";
        if (typeof params.value === "number") {
          bgColor = params.value > 60 ? "#ffdddd" : "";
          return (
            <div
              style={{
                width: "100%",
                height: "100%",
                backgroundColor: bgColor,
                display: "flex",
                alignItems: "center",
                paddingLeft: 8,
              }}
            >
              {Number(params.value).toFixed(2)}%
            </div>
          );
        }

        if (typeof params.value === "boolean") {
          return <div>{params.value ? "Yes" : "No"}</div>;
        }
        return <div>{params.formattedValue}</div>;
      },
    })),
  ];

  const metadataGroup = computeAverages(data.utilMetadataList);
  return (
    <div>
      <div>
        <h1>
          Workflow Level Utilization Reports:{" "}
          {data.utilMetadataList.length > 0
            ? data.utilMetadataList[0].repo +
              " " +
              data.utilMetadataList[0].workflow_name
            : "no report found"}
        </h1>
      </div>
      <h2> The average utilization usage across jobs in workflow run</h2>
      <MetadataGroupSection>
        {metadataGroup.map((item, idx) => {
          return (
            item.value && (
              <NumericRingChart key={idx}>
                <SingleValueGauge data={item} key={item.name} />
              </NumericRingChart>
            )
          );
        })}
      </MetadataGroupSection>

      <h2> Job Utilization Summary Table</h2>
      <span>Utilization metrics above 60% is highlighted</span>
      <div style={{ height: "1000px", width: "100%" }}>
        <DataGrid rows={rows} columns={columns} pageSizeOptions={[90]} />
      </div>
    </div>
  );
};
export default WorkflowUtilization;

function useUtilMetadata(workflowId: string | undefined): {
  utilMetadataList: UtilizationMetadataInfo[];
  metaError: any;
} {
  const { data, error } = useSWR<ListUtilizationMetadataInfoAPIResponse>(
    `/api/list_utilization_metadata_info/${workflowId}?includes_stats=true`,
    fetcher,
    {
      refreshInterval: 20 * 60 * 1000, // refresh every 20 minuts
      // Refresh even when the user isn't looking, so that switching to the tab
      // will always have fresh info.
      refreshWhenHidden: true,
    }
  );

  if (!workflowId) {
    return { utilMetadataList: [], metaError: "No workflow ID" };
  }

  if (error != null) {
    return {
      utilMetadataList: [],
      metaError: "Error occured while fetching util metadata",
    };
  }

  if (data == null) {
    return { utilMetadataList: [], metaError: "Loading..." };
  }

  if (data.metadata_list == null) {
    return { utilMetadataList: [], metaError: "No metadata list found" };
  }

  return { utilMetadataList: data.metadata_list, metaError: null };
}
