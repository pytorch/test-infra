import { PickerConfig } from "components/charts/line_rect_chart/lib/types";
import LineRectChart from "components/charts/line_rect_chart/LineRectChart";
import {
  Segment,
  UtilizationAPIResponse,
  UtilizationMetadata,
} from "lib/utilization/types";
import { useEffect, useState } from "react";
import { TestSectionView } from "../components/TestSectionView/TestSectionView";
import JobUtilizationSummary from "../components/UtilizationJobSummary/UtilizationJobSummary";
import { getIgnoredSegmentName, processStatsData } from "./helper";
import { Divider, MainPage, Section } from "./styles";
import { StatsInfo } from "./types";

export const lineFilters: PickerConfig[] = [
  { category: "all", types: [{ name: "all", tags: ["|"] }] },
  {
    category: "gpu",
    types: [
      { name: "gpu util", tags: ["gpu", "|util_percent"] },
      { name: "gpu mem", tags: ["gpu", "|mem_util_percent"] },
    ],
  },
  { category: "cpu", types: [{ name: "cpu", tags: ["cpu"] }] },
  { category: "memory", types: [{ name: "memory", tags: ["memory"] }] },
];

export const JobUtilizationPage = ({
  workflowId,
  jobId,
  attempt,
  data,
}: {
  workflowId: string;
  jobId: string;
  attempt: string;
  data: UtilizationAPIResponse;
}) => {
  const [testSegments, setTestSegments] = useState<Segment[]>([]);
  const [timeSeriesList, setTimeSeriesList] = useState<any[]>([]);
  const [metadata, setMetadata] = useState<any>();
  const [summaryData, setSummaryData] = useState<any[]>([]);

  // currently we only show data that is aggregated by max value during the data collection time interval.
  // this makes sense for utilization to detect potential effieciency issues, later our ui
  // can support other aggregation methods for analysis, it's very disruptive to add both in UI right now.
  const aggregateType = "max";

  useEffect(() => {
    if (!data) {
      return;
    }

    const util_metadata = data.metadata as UtilizationMetadata;
    const lines = data.ts_list;

    // currently we only show data that is aggregated by max value during the time interval
    const filteredLines = lines.filter((line) =>
      line.id.includes(aggregateType)
    );

    const jobStats: StatsInfo[] = processStatsData(filteredLines);

    const segments = util_metadata.segments;
    const filteredSeg = segments.filter((segment) => {
      for (const ignoreName of getIgnoredSegmentName()) {
        if (segment.name.includes(ignoreName)) {
          return false;
        }
      }
      return true;
    });
    setMetadata(util_metadata);
    setTimeSeriesList(filteredLines);
    setTestSegments(filteredSeg);
    setSummaryData(jobStats);
  }, [data]);

  return (
    <MainPage>
      <Section>
        <div>
          <JobUtilizationSummary
            aggregateType={aggregateType}
            metadata={metadata}
            tableData={summaryData}
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
            chartWidth={1400}
            disableLineTooltip={false}
            disableRect={true}
            lineFilterConfig={lineFilters}
          ></LineRectChart>
        </Section>
      )}
      {testSegments.length > 0 && timeSeriesList.length > 0 && (
        <Section>
          <TestSectionView
            testSegments={testSegments}
            timeSeriesList={timeSeriesList}
          />
        </Section>
      )}
    </MainPage>
  );
};
