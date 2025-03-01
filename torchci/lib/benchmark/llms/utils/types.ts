import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import _ from "lodash";
import {
  DEFAULT_ARCH_NAME,
  DEFAULT_BACKEND_NAME,
  DEFAULT_DEVICE_NAME,
  DEFAULT_DTYPE_NAME,
  DEFAULT_MODE_NAME,
  DEFAULT_MODEL_NAME,
  EXCLUDED_METRICS,
  REPO_TO_BENCHMARKS,
} from "../common";

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

/**
 * The enum type of a dropdown component
 * this is used to render dropdowns dynamically in the LLMs Benchmark page.
 * the fields should match the fields in LLMsBenchmarkProps
 */
export enum DropdownGroupItemType {
  ModelName = "modelName",
  BackendName = "backendName",
  ModeName = "modeName",
  DtypeName = "dtypeName",
  DeviceName = "deviceName",
  ArchName = "archName",
}

/**
 * The item of the dropdown group to render each dropdown
 * @property DropdownGroupItemType enum type
 * @property options the list of options in the dropdown
 * @property labelName the label name of the dropdown
 */
export interface DropdownGroupItem {
  type: DropdownGroupItemType;
  options: string[];
  labelName: string;
}

/**
 * toDefaultDropdownMapItems converts the optoins to UI-render-friendly dropdownGroupItems
 * @param option
 * @returns
 */
export function toDefaultDropdownMapItems(data: any): DropdownGroupItem[] {
  const modelNameList: string[] = [
    DEFAULT_MODEL_NAME,
    ...(_.uniq(data.map((r: any) => r.model)) as string[]),
  ];
  const backendNameList: string[] = _.compact([
    DEFAULT_BACKEND_NAME,
    ...(_.uniq(data.map((r: any) => r.backend)) as string[]),
  ]);
  const deviceNameList: string[] = [
    DEFAULT_DEVICE_NAME,
    ...(_.uniq(data.map((r: any) => `${r.device} (${r.arch})`)) as string[]),
  ];
  const modeNameList: string[] = _.compact([
    DEFAULT_MODE_NAME,
    ...(_.uniq(data.map((r: any) => r.mode)) as string[]),
  ]);
  const dtypeNameList: string[] = _.compact([
    DEFAULT_DTYPE_NAME,
    ...(_.uniq(data.map((r: any) => r.dtype)) as string[]),
  ]);

  return [
    {
      type: DropdownGroupItemType.ModelName,
      options: modelNameList,
      labelName: "Model",
    },
    {
      type: DropdownGroupItemType.BackendName,
      options: backendNameList,
      labelName: "Backend",
    },
    {
      type: DropdownGroupItemType.ModeName,
      options: modeNameList,
      labelName: "Mode",
    },
    {
      type: DropdownGroupItemType.DtypeName,
      options: dtypeNameList,
      labelName: "Dtype",
    },
    {
      type: DropdownGroupItemType.ArchName,
      options: [],
      labelName: "Platform",
    },
    {
      type: DropdownGroupItemType.DeviceName,
      options: deviceNameList,
      labelName: "Device",
    },
  ];
}

/**
 * generate default query params for clickhouse using the props of the LLMsBenchmarkpage
 * @param props LLMsBenchmarkProps
 */
export function getDefaultLLMsBenchmarkPropsQueryParameter(
  props: LLMsBenchmarkProps
) {
  const queryParams = {
    arch: props.archName === DEFAULT_ARCH_NAME ? "" : props.archName,
    device: props.deviceName === DEFAULT_DEVICE_NAME ? "" : props.deviceName,
    mode: props.modeName === DEFAULT_MODE_NAME ? "" : props.modeName,
    dtypes: props.dtypeName === DEFAULT_DTYPE_NAME ? [] : [props.dtypeName],
    excludedMetrics: EXCLUDED_METRICS,
    benchmarks: props.benchmarkName
      ? [props.benchmarkName]
      : REPO_TO_BENCHMARKS[props.repoName],
    granularity: props.granularity,
    models: props.modelName === DEFAULT_MODEL_NAME ? [] : [props.modelName],
    backends:
      props.backendName === DEFAULT_BACKEND_NAME ? [] : [props.backendName],
    repo: props.repoName,
    startTime: dayjs(props.startTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: dayjs(props.stopTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
  };
  return queryParams;
}
