import { Divider } from "@mui/material";
import { Stack } from "@mui/system";
import { BranchAndCommitPicker } from "components/benchmark/BranchAndCommitPicker";
import { DropdownGroupItem } from "lib/benchmark/llms/types/dashboardPickerTypes";
import { LLMsBenchmarkProps } from "lib/benchmark/llms/types/dashboardProps";
import { Dispatch } from "react";
import LLMsDropdownGroup from "./LLMsDropdownGroup";
import { LLMsTimeRangePicker } from "./LLMsTimeRangePicker";

export const LLMsDashboardPicker = ({
  options,
  props,
  dispatch,
  queryParams,
}: {
  props: LLMsBenchmarkProps;
  options?: DropdownGroupItem[];
  dispatch: Dispatch<any>;
  queryParams: any;
}) => {
  if (!options) {
    return (
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <LLMsTimeRangePicker props={props} dispatch={dispatch} />
      </Stack>
    );
  }

  const handleChange = (key: string, newVal: any) => {
    dispatch({ type: "UPDATE_FIELD", field: key, value: newVal });
  };
  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <LLMsTimeRangePicker props={props} dispatch={dispatch} />
        <LLMsDropdownGroup
          onChange={handleChange}
          props={props}
          optionListMap={options}
        />
        <BranchAndCommitPicker
          queryName={"oss_ci_benchmark_branches"}
          queryParams={queryParams}
          branch={props.lBranch}
          setBranch={(val: any) => {
            dispatch({ type: "UPDATE_FIELD", field: "lBranch", value: val });
          }}
          commit={props.lCommit}
          setCommit={(val: any) => {
            dispatch({ type: "UPDATE_FIELD", field: "lCommit", value: val });
          }}
          titlePrefix={"Base"}
          fallbackIndex={-1} // Default to oldest commit
          timeRange={props.timeRange}
        />
        <Divider orientation="vertical" flexItem>
          &mdash;Diff→
        </Divider>
        <BranchAndCommitPicker
          queryName={"oss_ci_benchmark_branches"}
          queryParams={queryParams}
          branch={props.rBranch}
          setBranch={(val: any) => {
            dispatch({ type: "UPDATE_FIELD", field: "rBranch", value: val });
          }}
          commit={props.rCommit}
          setCommit={(val: any) => {
            dispatch({ type: "UPDATE_FIELD", field: "rCommit", value: val });
          }}
          titlePrefix={"New"}
          fallbackIndex={0} // Default to the latest commit
          timeRange={props.timeRange}
        />
      </Stack>
    </div>
  );
};
