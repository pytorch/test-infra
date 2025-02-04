import { Paper } from "@mui/material";
import { PickerConfig } from "components/charts/line_rect_chart/lib/types";
import LineRectChart from "components/charts/line_rect_chart/LineRectChart";
import { UtilizationMetadata } from "lib/utilization/types";
import { useEffect, useState } from "react";
import { getIgnoredSegmentName } from "./helper";
import styles from "./UtilizationPage.module.css";

const lineFilters: PickerConfig[] = [
  { category: "hardware", types: ["gpu", "cpu", "memory"] },
  { category: "stats", types: ["max", "avg"] },
];

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
    <div className={styles.page}>
      <Paper className={styles.section}>
        <TestInformationSection
          workflowId={workflowId}
          jobId={jobId}
          attempt={attempt}
          jobName={metadata.job_name}
          workflowName={metadata.workflow_name}
        />
      </Paper>
      {timeSeriesList.length > 0 && (
        <Paper className={styles.section}>
          <h1>Utilization Time Series</h1>
          <div className={styles.divider}></div>
          <LineRectChart
            inputLines={timeSeriesList}
            disableLineTooltip={false}
            disableRect={true}
            lineFilterConfig={lineFilters}
          ></LineRectChart>
        </Paper>
      )}
      {testSegments.length > 0 && (
        <Paper className={styles.section}>
          <h1>Detected Python test details</h1>
          <div className={styles.divider}></div>
          <LineRectChart
            inputLines={timeSeriesList}
            rects={testSegments}
            disableLineTooltip={true}
            disableRect={false}
          ></LineRectChart>
          <div>
            <h3>Tests </h3>
            {testSegments.map((segment) => {
              return (
                <div key={segment.name}>
                  <div>{segment.name}</div>
                </div>
              );
            })}
          </div>
        </Paper>
      )}
    </div>
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
    <div className={styles.section}>
      <h1> Test Job Infomation</h1>
      <div className={styles.divider}></div>
      <div>
        <div>
          <span>Workflow(run)Id:</span>
          {workflowId}
        </div>
        <div>Job Id: {jobId} </div>
        <div>Attempt: {attempt}</div>
        <div>Job Name: {jobName}</div>
        <div>Workflow Name: {workflowName}</div>
      </div>
    </div>
  );
};
