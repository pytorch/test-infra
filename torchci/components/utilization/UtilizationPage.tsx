import { Divider, Paper, styled } from "@mui/material";
import { PickerConfig } from "components/charts/line_rect_chart/lib/types";
import LineRectChart from "components/charts/line_rect_chart/LineRectChart";
import { Metrics, UtilizationMetadata } from "lib/utilization/types";
import { useEffect, useState } from "react";
import JobUtilizationSummary from "./components/UtilizationJobSummary/UtilizationJobSummary";
import { getIgnoredSegmentName } from "./helper";
const lineFilters: PickerConfig[] = [
  { category: "hardware", types: ["gpu", "cpu", "memory"] },
  { category: "stats", types: ["max", "avg"] },
];



const MainPage = styled("div")({
  fontFamily: "Verdana, sans-serif",
});

const Section = styled("div")({
  margin: "10px",
  padding: "10px",
});



export const UtilizationPage = ({
  workflowId,
  jobId,
  attempt,
  lines = [],
  metadata,
  hardwareMetrics,
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
        <div>
          <JobUtilizationSummary
            hardwareMetrics={hardwareMetrics}
            metadata={metadata}
            workflowId={workflowId}
            jobId={jobId}
            attempt={attempt}
          />
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
