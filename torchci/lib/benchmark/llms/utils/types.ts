import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import _ from "lodash";

import { TORCHAO_BASELINE } from "../aoUtils";
import { DEFAULT_ARCH_NAME, DEFAULT_BACKEND_NAME, DEFAULT_DEVICE_NAME, DEFAULT_DTYPE_NAME, DEFAULT_MODE_NAME, DEFAULT_MODEL_NAME } from "../common";

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


// TODO(elainewy): process the data for each feature more dynamically
/**
 * toDefaultDropdownMapItems converts the optoins to UI-render-friendly dropdownGroupItems
 * @param option
 * @returns
 */
export function getBenchmarkDropdownFeatures(data: any, repoName:string): DropdownGroupItem[] {

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

  let items:DropdownGroupItem[] = [
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
  ];

  // TODO(elainewy): add config to handle repos-specific logics, this is only temporary
  const deviceFeature: DropdownGroupItem=
  {
      type: DropdownGroupItemType.DeviceName,
      options: deviceNameList,
      labelName: "Device",
  }

  // TODO(elainewy): add config to handle repos-specific logics
  if (repoName === "pytorch/executorch") {
    const archFeature = {
      type: DropdownGroupItemType.ArchName,
      options: [DEFAULT_ARCH_NAME, "Android", "iOS"],
      labelName: "Platform",
    }
    items = [...items, archFeature, deviceFeature]
  } else{
    items = [...items, deviceFeature]
  }
  return items;
}
