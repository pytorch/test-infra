import { PickerConfig } from "components/charts/line_rect_chart/lib/types";
import LineRectChart from "components/charts/line_rect_chart/LineRectChart";
import {
  UtilizationAPIResponse,
  UtilizationMetadata,
} from "lib/utilization/types";
import { useEffect, useState } from "react";
import { getIgnoredSegmentName } from "./helper";
import styles from "./UtilizationPage.module.css";

const lineFilters: PickerConfig[] = [
  { category: "all", types: [{ name: "all", tags: ["|"] }] },
  { category: "all max", types: [{ name: "max", tags: ["max"] }] },
  { category: "all average", types: [{ name: "avg", tags: ["avg"] }] },
  {
    category: "gpu max",
    types: [
      { name: "gpu util", tags: ["gpu", "max", "|util_percent"] },
      { name: "gpu mem", tags: ["gpu", "max", "|mem_util_percent"] },
    ],
  },
  { category: "cpu", types: [{ name: "cpu", tags: ["cpu"] }] },
  { category: "memory", types: [{ name: "memory", tags: ["memory"] }] },
];

export const UtilizationPage = ({
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
  const [testSegments, setTestSegments] = useState<any[]>([]);
  const [timeSeriesList, setTimeSeriesList] = useState<any[]>([]);
  const [metadata, setMetadata] = useState<any>();

  useEffect(() => {
    if (!data) {
      return;
    }

    const util_metadata = data.metadata as UtilizationMetadata;
    const lines = data.ts_list;
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
    setTimeSeriesList(lines);
    setTestSegments(filteredSeg);
  }, [data]);

  return (
    <div className={styles.page}>
      {metadata && (
        <div className={styles.section}>
          <TestInformationSection
            workflowId={workflowId}
            jobId={jobId}
            attempt={attempt}
            jobName={metadata.job_name}
            workflowName={metadata.workflow_name}
          />
        </div>
      )}
      {timeSeriesList.length > 0 && (
        <div className={styles.section}>
          <h3>Utilization Time Series</h3>
          <div className={styles.divider}></div>
          <LineRectChart
            inputLines={timeSeriesList}
            chartWidth={1200}
            disableLineTooltip={false}
            disableRect={true}
            lineFilterConfig={lineFilters}
          ></LineRectChart>
        </div>
      )}
      {testSegments.length > 0 && (
        <div className={styles.section}>
          <h3>Detected Python test details</h3>
          <div className={styles.divider}></div>
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
        </div>
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
