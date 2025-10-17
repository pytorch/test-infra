import { Stack } from "@mui/system";
import {
  UMDenseDropdown,
  UMDenseDropdownOption,
} from "components/uiModules/UMDenseComponents";

/**
 * The enum type of benchmark dashboard dropgroup item
 * this is used to render dropdowns dynamically in the LLMs Benchmark page.
 * the field value must match the fields in LLMsBenchmarkProps
 */
export enum BenchmarkDropdownGroupItemType {
  ModelName = "model",
  BackendName = "backend",
  ModeName = "modeN",
  DtypeName = "dtype",
  DeviceName = "deviceName",
  ArchName = "arch",
  Qps = "qps",
}

/**
 * The input item for benchmark dashboard dropdown
 * @property DropdownGroupItemType enum type
 * @property options the list of options in the dropdown
 * @property labelName the label name of the dropdown
 */
export interface BenchmarkDropdownGroupItem {
  type: BenchmarkDropdownGroupItemType;
  options: (string | UMDenseDropdownOption)[];
  labelName: string;
}

export default function BenchmarkDropdownGroup({
  onChange,
  props,
  optionListMap,
}: {
  onChange: (_key: string, _value: any) => void;
  props: any;
  optionListMap: BenchmarkDropdownGroupItem[];
}) {
  return (
    <Stack spacing={1}>
      {optionListMap.length > 1 &&
        optionListMap.map((option, index) => {
          const type = option.type;
          const olist = option.options;
          if (!olist || olist.length <= 1) {
            return null;
          }
          return (
            <UMDenseDropdown
              key={index}
              dtype={props[type]}
              setDType={(val: any) => {
                onChange(type, val);
              }}
              dtypes={olist}
              label={option.labelName}
            />
          );
        })}
    </Stack>
  );
}
