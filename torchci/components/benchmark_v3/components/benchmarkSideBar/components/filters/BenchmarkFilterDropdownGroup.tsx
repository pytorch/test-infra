import { Stack } from "@mui/system";
import { BenchmarkUIConfigFilterConstarintConfig } from "components/benchmark_v3/configs/config_book_types";
import {
  UMDenseDropdown,
  UMDenseDropdownOption,
} from "components/uiModules/UMDenseComponents";

/**
 * The input item for benchmark dashboard dropdown
 * @property DropdownGroupItemType enum type
 * @property options the list of options in the dropdown
 * @property labelName the label name of the dropdown
 */
export interface BenchmarkDropdownGroupItem {
  type: string;
  options: (string | UMDenseDropdownOption)[];
  labelName: string;
}

export default function BenchmarkDropdownGroup({
  onChange,
  props,
  config,
  optionListMap,
  horizontal = false,
}: {
  onChange: (_key: string, _value: any) => void;
  props: any;
  optionListMap: BenchmarkDropdownGroupItem[];
  config?: BenchmarkUIConfigFilterConstarintConfig;
  horizontal?: boolean;
}) {
  return (
    <Stack spacing={1} direction={horizontal ? "row" : "column"}>
      {optionListMap.length > 1 &&
        optionListMap.map((option, index) => {
          const type = option.type;
          let olist = option.options;
          if (!olist || olist.length <= 1) {
            return null;
          }

          let disable = false;
          if (config && config[type]) {
            const c = config[type];
            disable = c.disabled ?? false;
            olist = olist.filter((o) => {
              if (typeof o === "string") {
                // Exclude if listed in disableOptions
                return !c.disableOptions?.includes(o);
              }
              // Exclude if option.value is listed in disableOptions
              return !c.disableOptions?.includes(o.value);
            });
          }

          return (
            <UMDenseDropdown
              key={index}
              dtype={props[type]}
              setDType={(val: any) => {
                onChange(type, val);
              }}
              disable={disable}
              dtypes={olist}
              label={option.labelName}
            />
          );
        })}
    </Stack>
  );
}
