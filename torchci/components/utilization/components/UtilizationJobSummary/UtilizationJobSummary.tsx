import { Paper, styled } from "@mui/material";
import { getDurationMetrics } from "components/utilization/JobUtilizationPage/helper";
import { UtilizationMetadata } from "lib/utilization/types";
import { useEffect, useState } from "react";
import SingleValueGauge from "../SingleValueGauge";
import UtilizationStatsTable from "../UtilizationStatsTable";
import { UtilizationJobInformation } from "./UtilizationJobInformation";

const ContainerSection = styled("div")({
  display: "flex",
});

const SectionTitle = styled("div")({
  fontSize: "20px",
  margin: "10px",
});

const AggregationModeInfo = styled(Paper)({
  margin: "5px",
  padding: "10px",
  fontSize: "16px",
  maxWidth: "1000px",
});

const StatsTable = styled("div")({
  width: "1400px",
  margin: "10px",
});

const MetadataGroupSection = styled("div")({
  display: "flex",
  flexWrap: "wrap",
  minWidth: "550px",
  alignItems: "center",
});

export const NumericRingChart = styled("div")({
  display: "flex",
  width: "250px",
  height: "200px",
});

const Divider = styled("div")({
  borderBottom: "1px solid #ccc",
  margin: "20px 0",
});

const JobUtilizationSummary = ({
  aggregateType,
  metadata,
  tableData,
  workflowId,
  jobId,
  attempt,
}: {
  aggregateType: string;
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
      "Test Duration",
      "duration"
    );
    const numeric_metrics = getMetadataStats(metadata);
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
      <StatsTable>
        <SectionTitle> Test Job Metrics Summary Table</SectionTitle>
        <UtilizationStatsTable data={tableData} />
      </StatsTable>
    </div>
  );
};
export default JobUtilizationSummary;

function getMetadataStats(metadata: UtilizationMetadata) {
  let list = [];
  const keys = ["cpu_count", "gpu_count"];
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
