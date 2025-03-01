import { DropdownGroupItem, LLMsBenchmarkProps } from "./types";

export enum CustomConfigOperation {
  REMOVE = "remove",
  Upsert = "upsert",
}

export interface OperationGuide {
  identifier: string;
  operation: CustomConfigOperation;
  value?: any;
}

export interface CustomConfig {
  benchmarkName: string;
  repoName: string;
  pickerListOrder?: string[];
  pickerListMapModifier?: (dropdownMapList: DropdownGroupItem[]) => void;
  propsQueryParamModifier?: (
    queryParam: any,
    props: LLMsBenchmarkProps
  ) => void;
  [k: string]: any;
}

/**
 * CustomConfigObject is the object that will be used to store the custom config and operation methods
 */
export class CustomConfigObject implements CustomConfig {
  pickerListMapModifier?: (
    dropdownMapList: DropdownGroupItem[]
  ) => DropdownGroupItem[];
  propsQueryParamModifier?: (
    queryParam: any,
    props: LLMsBenchmarkProps
  ) => LLMsBenchmarkProps;
  benchmarkName: string = "";
  repoName: string = "";

  constructor(customConfig?: any) {
    if (!customConfig) {
      return;
    }
    this.pickerListMapModifier = customConfig.pickerListMapModifier
      ? customConfig.pickerListMapModifier
      : undefined;
    this.propsQueryParamModifier = customConfig.propsQueryParamModifier
      ? customConfig.queryParamModifier
      : undefined;
    customConfig.pickerOption ? customConfig.pickerOption : [];
    this.benchmarkName = customConfig.benchmarkName
      ? customConfig.benchmarkName
      : "";
    this.repoName = customConfig.repoName ? customConfig.repoName : "";
  }

  hasCustomizedPickerProcess() {
    return this.pickerListMapModifier ? true : false;
  }

  processPropsQueryParam(queryParams: any, props: LLMsBenchmarkProps) {
    if (!this.propsQueryParamModifier) {
      return queryParams;
    }
    return this.propsQueryParamModifier(queryParams, props);
  }

  processPickerListMapModifier(dropdownMapList: DropdownGroupItem[]) {
    if (!this.pickerListMapModifier) {
      return dropdownMapList;
    }
    return this.pickerListMapModifier(dropdownMapList);
  }
}
