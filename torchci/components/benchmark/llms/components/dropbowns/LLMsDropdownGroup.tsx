import { Stack } from "@mui/system";
import { DTypePicker } from "components/benchmark/ModeAndDTypePicker";
import {
  DropdownGroupItem,
  LLMsBenchmarkProps,
} from "lib/benchmark/llms/utils/types";

export default function LLMsDropdownGroup({
  onChange,
  props,
  optionListMap,
}: {
  onChange: (key: string, value: any) => void;
  props: LLMsBenchmarkProps;
  optionListMap: DropdownGroupItem[];
}) {
  return (
    <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
      {optionListMap.length > 1 &&
        optionListMap.map((option, index) => {
          const type = option.type;
          const olist = option.options;
          if (!olist || olist.length <= 1) {
            return <></>;
          }
          return (
            <DTypePicker
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
