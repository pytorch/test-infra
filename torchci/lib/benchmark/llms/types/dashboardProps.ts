import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";

/**
 * The props for the LLMs Benchmark props. this is used to pass the props to the LLMs Benchmark components.
 * @param startTime The start time of the graph.
 * @param stopTime The stop time of the graph.
 * @param timeRange The time range of the graph.
 * @param repoName The name of the repository.
 * @param benchmarkName The name of the benchmark.
 * @param modelName The name of the model.
 * @param backendName The name of the backend.
 * @param modeName The name of the mode.
 * @param dtypeName The name of the data type.
 * @param deviceName The name of the device.
 * @param archName The name of the architecture.
 * @param granularity The granularity of the graph.
 *
 */
export interface LLMsBenchmarkProps {
  repoName: string;
  benchmarkName: string;
  // dropdown props
  modelName: string;
  backendName: string;
  modeName: string;
  dtypeName: string;
  deviceName: string;
  archName: string;
  // time picker props
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  timeRange: number;
  granularity: Granularity;
  lCommit: string;
  rCommit: string;
  lBranch: string;
  rBranch: string;
}
