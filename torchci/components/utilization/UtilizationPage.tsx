import { PickerConfig } from "components/charts/line_chart_with_segments/d3_chart_utils/utils";
import LineChartWithSegments from "components/charts/line_chart_with_segments/LineChartWithSegments";
import { UtilizationMetadata } from "lib/utilization/types";
import { useEffect, useState } from "react";
import { getIgnoredSegmentName } from "./helper";
import styles from "./UtilizationPage.module.css";

export const UtilizationPage = ({
  workflowId,
  jobId,
  attempt,
  lines = [],
  metadata,
}: {
  workflowId: string;
  jobId: string;
  attempt: string;
  lines: {
    name: string;
    records: { ts: string; value: number }[];
  }[];
  metadata: UtilizationMetadata;
}) => {
  const [testSegments, setTestSegments] = useState<any[]>([]);
  const [clickedTest, setClickedTest] = useState<string>("");

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

    setTestSegments(filteredSeg);
  }, [lines, metadata]);

  function clickTest(testName: string) {
    setClickedTest(testName);
  }

  function getLineCategoryConfig(): Map<string, PickerConfig> {
    return new Map([
      ["hardware", { category: "hardware", types: ["gpu", "cpu", "memory"] }],
      ["stats", { category: "stats", types: ["max", "avg"] }],
    ]);
  }

  return (
    <div className={styles.page}>
      <div className={styles.section}>
        <h1> Test Job Infomation</h1>
        <div className={styles.divider}></div>
        <div>
          <span>Workflow(run)Id:{workflowId}</span>
          <span>Job Id: {jobId} </span>
          <span>Attempt: {attempt}</span>
          <span>Job Name: {metadata?.job_name}</span>
          <span>workflow_name: {metadata?.workflow_name}</span>
        </div>
      </div>
      <div className={styles.section}>
        <h1>Utilization Time Series</h1>
        <div className={styles.divider}></div>
        <LineChartWithSegments
          inputLines={lines}
          segments={testSegments}
          disableLineTooltip={false}
          disableSegment={true}
          linePickerConfig={getLineCategoryConfig()}
        ></LineChartWithSegments>
      </div>
      <div className={styles.section}>
        <h1>Detected Python test details</h1>
        <div className={styles.divider}></div>
        <LineChartWithSegments
          inputLines={lines}
          segments={testSegments}
          disableLineTooltip={true}
          disableSegment={false}
        ></LineChartWithSegments>
      </div>
    </div>
  );
};
