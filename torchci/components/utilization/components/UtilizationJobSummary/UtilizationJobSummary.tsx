import { styled } from "@mui/material";
import { getDurationMetrics } from "components/utilization/helper";
import { UtilizationMetadata } from "lib/utilization/types";
import { useEffect, useState } from "react";
import SingleValueGauge from "../SingleValueGauge";
import UtilizationJobMetricsTable from "../UtilizationJobMetricsTable";
import { UtilizationJobInformation } from "./UtilizationJobInformation";

function getNumericMetrics(metadata: UtilizationMetadata) {
  let list = [];
  const keys = Object.keys(metadata);
  for (const key of keys) {
    const name = key.split("_").join(" ");
    const value = metadata[key as keyof UtilizationMetadata];
    if (typeof value === "number") {
      list.push({
        name: name,
        metrics: {
          name: name,
          id: key,
          value: value,
          metric: "numeric",
          unit: key.includes("interval") ? "secs" : "",
        },
      });
    }
  }
  return list;
}

const ContainerSection = styled("div")({
  display: "flex",
});

const SectionTitle = styled("div")({
  fontSize: "20px",
  margin: "10px",
});

const MetricsTable = styled("div")({
  width: "1200px",
  margin: "10px",
});

const MetadataGroupSection = styled("div")({
  display: "flex",
  flexWrap: "wrap",
  minWidth: "550px",
  alignItems: "center",
});

const NumericRingChart = styled("div")({
  display: "flex",
  width: "250px",
  height: "200px",
});

const Divider = styled("div")({
  borderBottom: "1px solid #ccc",
  margin: "20px 0",
});

const JobUtilizationSummary = ({
  metadata,
  tableData,
  workflowId,
  jobId,
  attempt,
}: {
  metadata: UtilizationMetadata;
  tableData: any[];
  workflowId: string;
  jobId: string;
  attempt: string;
}) => {
  const [metadataGroup, setMetadataGroup] = useState<
    { name: string; metrics?: any }[]
  >([]);

  useEffect(() => {
    if (!metadata) return;
    const duration = getDurationMetrics(
      new Date(metadata.start_at),
      new Date(metadata.end_at),
      "Job Duration",
      "job|duration"
    );
    const numeric_metrics = getNumericMetrics(metadata);
    const mdm = [duration, ...numeric_metrics];
    setMetadataGroup(mdm);
  }, [metadata]);

  if (!metadata) {
    return <div></div>;
  }

  return (
    <div>
      <h1> Utilization Summary</h1>
      <Divider></Divider>
      <ContainerSection>
        <UtilizationJobInformation
          workflowId={workflowId}
          jobId={jobId}
          attempt={attempt}
          jobName={metadata.job_name}
          workflowName={metadata.workflow_name}
        />
        <MetadataGroupSection>
          {metadataGroup.map((item, idx) => {
            return (
              item.metrics && (
                <NumericRingChart key={idx}>
                  <SingleValueGauge data={item.metrics} key={item.name} />
                </NumericRingChart>
              )
            );
          })}
        </MetadataGroupSection>
      </ContainerSection>
      <MetricsTable>
        <SectionTitle> Job Metrics Summary Table</SectionTitle>
        <UtilizationJobMetricsTable data={tableData} />
      </MetricsTable>
    </div>
  );
};
export default JobUtilizationSummary;
