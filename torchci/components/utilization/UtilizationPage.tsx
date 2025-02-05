import { Paper, styled } from "@mui/material";
import { PickerConfig } from "components/charts/line_rect_chart/lib/types";
import LineRectChart from "components/charts/line_rect_chart/LineRectChart";
import { Metrics, UtilizationMetadata } from "lib/utilization/types";
import { useEffect, useState } from "react";
import JobUtilizationSummary from "./components/JobSummary/JobUtilizationSummary";
import { getIgnoredSegmentName } from "./helper";
const lineFilters: PickerConfig[] = [
  { category: "hardware", types: ["gpu", "cpu", "memory"] },
  { category: "stats", types: ["max", "avg"] },
];

const Divider = styled("div")({
  borderBottom: "1px solid #ccc",
  margin: "20px 0",
});

const MainPage = styled("div")({
  fontFamily: "Verdana, sans-serif",
});


const Section = styled("div")({
  margin: "10px",
  padding: "10px",
});

const PaperCard = styled(Paper)({
  width: "300px",
  padding: "10px",
});

const JobInfoTitle = styled('span')({
  marginRight: "5px",
  fontSize: "16px",
  fontWeight: "bold",
});

export const UtilizationPage = ({
  workflowId,
  jobId,
  attempt,
  lines = [],
  metadata,
  hardwareMetrics,
  otherMetrics,
}: {
  workflowId: string;
  jobId: string;
  attempt: string;
  lines: {
    name: string;
    displayname: string;
    records: { ts: string; value: number }[];
  }[];
  metadata: UtilizationMetadata;
  hardwareMetrics: Metrics[];
  otherMetrics: Metrics[];
}) => {
  const [testSegments, setTestSegments] = useState<any[]>([]);
  const [timeSeriesList, setTimeSeriesList] = useState<any[]>([]);

  useEffect(() => {
    const segments = metadata.segments;
    const filteredSeg = segments.filter((segment) => {
      for (const ignoreName of getIgnoredSegmentName()) {
        if (segment.name.includes(ignoreName)) {
          return false;
        }
      }
      return true;
    });
    setTimeSeriesList(lines);
    setTestSegments(filteredSeg);
  }, [lines, metadata]);

  return (
    <MainPage>
      <Section>
        <TestInformationSection
          workflowId={workflowId}
          jobId={jobId}
          attempt={attempt}
          jobName={metadata.job_name}
          workflowName={metadata.workflow_name}
        />
      </Section>
      <Section>
        <div>
          <JobUtilizationSummary hardwareMetrics={hardwareMetrics} otherMetrics={otherMetrics} />
        </div>
      </Section>
      {timeSeriesList.length > 0 && (
        <Section>
          <h3>Utilization Time Series</h3>
          <Divider />
          <LineRectChart
            inputLines={timeSeriesList}
            chartWidth={1200}
            disableLineTooltip={false}
            disableRect={true}
            lineFilterConfig={lineFilters}
          ></LineRectChart>
        </Section>
      )}
      {testSegments.length > 0 && (
        <Section>
          <h3>Detected Python test details</h3>
          <Divider />
          <LineRectChart
            inputLines={timeSeriesList}
            chartWidth={1200}
            rects={testSegments}
            disableLineTooltip={true}
            disableRect={false}
          ></LineRectChart>
          <div>
            <h4>Tests </h4>
            {testSegments.map((segment) => {
              return (
                <div key={segment.name}>
                  <div>{segment.name}</div>
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </MainPage>
  );
};

const TestInformationSection = ({
  workflowId,
  jobId,
  attempt,
  jobName,
  workflowName,
}: {
  workflowId: string;
  jobId: string;
  attempt: string;
  jobName: string;
  workflowName: string;
}) => {
  return (
    <Section>
      <h1> Test Job Infomation</h1>
      <Divider />
      <PaperCard>
        <div>
          <div>
            <JobInfoTitle>Job Name:</JobInfoTitle>
            <span>{jobName}</span>
          </div>
          <div>
            <JobInfoTitle>Workflow Name:</JobInfoTitle>
            <span>{workflowName}</span>
          </div>
          <div>
            <JobInfoTitle>Workflow(run)Id:</JobInfoTitle>
            <span>{workflowId}</span>
          </div>
          <div>
            <JobInfoTitle>Job Id:</JobInfoTitle>
            <span>{jobId}</span>
          </div>
          <div>
            <JobInfoTitle>Attempt:</JobInfoTitle>
            <span>{attempt}</span>
          </div>
        </div>
      </PaperCard>
    </Section>
  );
};
