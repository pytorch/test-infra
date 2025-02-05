import { Paper, styled } from "@mui/material";
import { Metrics, MetricType, UtilizationMetadata } from "lib/utilization/types";
import { useEffect, useState } from "react";
import DoubleRingChart from "./DoubleRingChart";
import RoundChart from "./RoundChart";
import { UtilizationJobInformation } from "./UtilizationJobInformation";

const ContainerSection = styled("div")({
  display: "flex",
});


const DoubleRingSectionTitle = styled("div")({
  fontSize: "20px",
  fontWeight: "bold",
});

const MetadataGroupSection = styled("div")({
  display: "flex",
  flexWrap: "wrap",
  minWidth: "550px",
  alignItems: "center",
});

const DoubleMetricsGroupSection = styled("div")({
  display: "flex",
  flexWrap: "wrap",
  margin: "10px",
});

const RingChart = styled("div")({
  display: "flex",
  width: "450px",
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

const hardwareName = ["gpu", "cpu", "memory"];

const JobUtilizationSummary = ({
  hardwareMetrics,
  metadata,
  workflowId,
  jobId,
  attempt,
}: {
  hardwareMetrics: Metrics[];
  metadata: UtilizationMetadata;
  workflowId: string;
  jobId: string;
  attempt:string,
}) => {
  const [utilGroups, setUtilGroups] = useState<
    { name: string; metircType: string; metrics: Metrics[] }[]
  >([]);
  const [metadataGroup, setMetadataGroup] = useState<
    { name: string; metrics?: Metrics }[]
  >([]);

  useEffect(() => {
    if (!hardwareMetrics || !metadata) return;

    const duration = getDurationMetrics(
      new Date(metadata.start_at),
      new Date(metadata.end_at),
      "Job Duration",
      "job|duration"
    );
    const groupAvg = hardwareName.map((name) => {
      const filteredGroup = hardwareMetrics.filter(
        (metric) => metric.name.includes(name) && metric.metric == MetricType.AVERAGE
      );
      return {
        name: name,
        metrics: filteredGroup,
        metircType: MetricType.AVERAGE,
      };
    });

    const groups90 = hardwareName.map((name) => {
      const filteredGroup = hardwareMetrics.filter(
        (metric) => metric.name.includes(name) && metric.metric == MetricType.PERCENTILE_90TH
      );
      return {
        name: name,
        metrics: filteredGroup,
        metircType: MetricType.PERCENTILE_90TH,
      };
    });

    const groups50 = hardwareName.map((name) => {
      const filteredGroup = hardwareMetrics.filter(
        (metric) => metric.name.includes(name) && metric.metric == MetricType.PERCENTILE_50TH
      );
      return {
        name: name,
        metrics: filteredGroup,
        metircType: MetricType.PERCENTILE_50TH,
      };
    });

    setUtilGroups([...groupAvg,...groups50, ...groups90]);

    const numeric_metrics = getNumericMetrics(metadata);
    const mdm = [duration, ...numeric_metrics];
    setMetadataGroup(mdm);
  }, [metadata, hardwareMetrics]);

  return (
    <div>
      <h1> Utilization Summary</h1>
      <Divider></Divider>
      <div>C.B (Calculated By): Utilization metrics is generated every 0.5 seconds, then averaged and maximized over {metadata.collect_interval}-second intervals to collect time series data point."</div>
        <ContainerSection>
        <UtilizationJobInformation
          workflowId={workflowId}
          jobId={jobId}
          attempt={attempt}
          jobName={metadata.job_name}
          workflowName={metadata.workflow_name}
        />
          <MetadataGroupSection>
            {metadataGroup.map((item) => {
              return (
                item.metrics && (
                  <NumericRingChart>
                    <RoundChart data={item.metrics} key={item.name} />
                  </NumericRingChart>
                )
              );
            })}
          </MetadataGroupSection>
        </ContainerSection>
        <div>
        {hardwareName && hardwareName.map((sectionName) => {
          return (
            <div>
            <DoubleRingSectionTitle>{sectionName}</DoubleRingSectionTitle>
            <DoubleMetricsGroupSection>
              {utilGroups.map((group) => {
                if (group.name !== sectionName) return null;
                return (
                  group.metrics.length > 0 && (
                      <div>
                        <div>
                          {" "}
                          {group.metircType} of totoal {group.name} utilization.
                        </div>
                        <RingChart>
                          <DoubleRingChart
                            data={group.metrics}
                            key={group.name}
                          />
                        </RingChart>
                      </div>
                  )
                );
              })}
            </DoubleMetricsGroupSection>
            </div>
                );
              })}
          </div>
    </div>
  );
};
export default JobUtilizationSummary;

const TypingText = ({ input }: { input: string }) => {
  const [text, setText] = useState("");
  const [fullText, setFullText] = useState("");
  const [speed, setSpeed] = useState(50); // speed in milliseconds

  useEffect(() => {
    setFullText(input);
  }, [input]);

  useEffect(() => {
    if (!fullText) return;
    let i = 0;
    const intervalId = setInterval(() => {
      if (i < fullText.length) {
        setText(fullText.substring(0, i + 1));
        i++;
      } else {
        clearInterval(intervalId);
      }
    }, speed);
    return () => clearInterval(intervalId);
  }, [fullText, speed]);

  return (
    <div>
      <p>{text}</p>
    </div>
  );
};

function getDurationMetrics(
  start: Date,
  end: Date,
  displayname: string,
  id?: string
) {
  const duration = (end.getTime() - start.getTime()) / 1000 / 60;
  let metricId = id || displayname;
  const metrics: Metrics = {
    displayname: displayname,
    name: metricId,
    value: Number(duration.toFixed(2)),
    metric: "total",
    unit: "mins",
  };
  return { name: displayname, metrics: metrics };
}

function getNumericMetrics(metadata: UtilizationMetadata) {
  let list = [];
  const keys = Object.keys(metadata);
  for (const key of keys) {
    const displayname = key.split("_").join(" ");
    const value = metadata[key as keyof UtilizationMetadata];
    if (typeof value === "number") {
      list.push({
        name: displayname,
        metrics: {
          displayname: displayname,
          name: key,
          value: value,
          metric: "numeric",
          unit: key.includes("interval") ? "secs" : "",
        },
      });
    }
  }
  return list;
}
