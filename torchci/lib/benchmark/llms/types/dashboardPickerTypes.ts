/**
 * The enum type of benchmark dashboard dropgroup item
 * this is used to render dropdowns dynamically in the LLMs Benchmark page.
 * the field value must match the fields in LLMsBenchmarkProps
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
 * The input item for benchmark dashboard dropdown
 * @property DropdownGroupItemType enum type
 * @property options the list of options in the dropdown
 * @property labelName the label name of the dropdown
 */
export interface DropdownGroupItem {
  type: DropdownGroupItemType;
  options: string[];
  labelName: string;
}
