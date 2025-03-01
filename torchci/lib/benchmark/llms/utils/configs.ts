import { TORCHAO_BASELINE } from "../aoUtils";
import { DEFAULT_ARCH_NAME } from "../common";
import { CustomConfig, CustomConfigObject } from "./configTypes";
import {
  DropdownGroupItem,
  DropdownGroupItemType,
  LLMsBenchmarkProps,
} from "./types";

const DEFAULT_PICKER_LIST_ORDER = [
  DropdownGroupItemType.ModelName,
  DropdownGroupItemType.BackendName,
  DropdownGroupItemType.ModeName,
  DropdownGroupItemType.DtypeName,
  DropdownGroupItemType.ArchName,
  DropdownGroupItemType.DeviceName,
];

// Custom config for pytorch/executorch
const ExecuTorchCustomConfig: CustomConfig = {
  benchmarkName: "executorch",
  repoName: "pytorch/executorch",
  pickerListMapModifier: (pickerListMap: DropdownGroupItem[]) => {
    const item = pickerListMap.find(
      (item) => item.type == DropdownGroupItemType.ArchName
    );
    const archItem = {
      type: DropdownGroupItemType.ArchName,
      labelName: "platform",
      options: [DEFAULT_ARCH_NAME, "Android", "iOS"],
    };
    if (!item) {
      pickerListMap.push(archItem);
      const identities = DEFAULT_PICKER_LIST_ORDER;
      pickerListMap.sort(
        (a, b) => identities.indexOf(a.type) - identities.indexOf(b.type)
      );
    } else {
      item.options = archItem.options;
      item.labelName = archItem.type;
    }
    return pickerListMap;
  },
};

const TorchAOCustomConfig: CustomConfig = {
  benchmarkName: "torchao",
  repoName: "pytorch/ao",
  queryParamModifier: (queryParam: any, props: LLMsBenchmarkProps) => {
    queryParam.dtypes =
      props.dtypeName === DEFAULT_ARCH_NAME
        ? []
        : [props.dtypeName, TORCHAO_BASELINE];
  },
};

//props.repoName !== "pytorch/ao"
//? [props.dtypeName]
//: [props.dtypeName, TORCHAO_BASELINE],

// Main CustomConfig object
const CUSTOM_CONFIG: { [k: string]: CustomConfig } = {
  "pytorch/executorch": ExecuTorchCustomConfig,
  "pytorch/ao": TorchAOCustomConfig,
};

/**
 * method to get custom config object for a repo
 * @param repoName
 * @returns
 */
export function getCustomConfig(repoName: string) {
  return CUSTOM_CONFIG[repoName]
    ? new CustomConfigObject(CUSTOM_CONFIG[repoName])
    : null;
}
