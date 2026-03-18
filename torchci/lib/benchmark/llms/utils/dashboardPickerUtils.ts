// TODO(elainewy): process the data for each feature more dynamically

import _ from "lodash";
import {
  DEFAULT_ARCH_NAME,
  DEFAULT_BACKEND_NAME,
  DEFAULT_DEVICE_NAME,
  DEFAULT_DTYPE_NAME,
  DEFAULT_MODE_NAME,
  DEFAULT_MODEL_NAME,
} from "../common";
import {
  DropdownGroupItem,
  DropdownGroupItemType,
} from "../types/dashboardPickerTypes";

/**
 * toDefaultDropdownMapItems converts the optoins to UI-render-friendly dropdownGroupItems
 * @param option
 * @returns
 */
export function getBenchmarkDropdownFeatures(
  data: any,
  repoName: string
): DropdownGroupItem[] {
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

  let items: DropdownGroupItem[] = [
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
  const deviceFeature: DropdownGroupItem = {
    type: DropdownGroupItemType.DeviceName,
    options: deviceNameList,
    labelName: "Device",
  };

  // TODO(elainewy): add config to handle repos-specific logics
  if (repoName === "pytorch/executorch") {
    const archFeature = {
      type: DropdownGroupItemType.ArchName,
      options: [DEFAULT_ARCH_NAME, "Android", "iOS"],
      labelName: "Platform",
    };
    items = [...items, archFeature, deviceFeature];
  } else {
    items = [...items, deviceFeature];
  }
  return items;
}
