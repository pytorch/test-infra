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
