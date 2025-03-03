import GranularityPicker from "components/GranularityPicker";
import { TimeRangePicker } from "pages/metrics";
import { Dispatch } from "react";
export const LLMsTimeRangePicker = ({
  props,
  dispatch,
}: {
  props: any;
  dispatch: Dispatch<any>;
}) => {
  return (
    <>
      <TimeRangePicker
        startTime={props.startTime}
        setStartTime={(val: any) => {
          dispatch({ type: "UPDATE_FIELD", field: "startTime", value: val });
        }}
        stopTime={props.stopTime}
        setStopTime={(val: any) => {
          dispatch({ type: "UPDATE_FIELD", field: "stopTime", value: val });
        }}
        timeRange={props.timeRange}
        setTimeRange={(val: any) => {
          dispatch({ type: "UPDATE_FIELD", field: "timeRange", value: val });
        }}
        setGranularity={(val: any) => {
          dispatch({ type: "UPDATE_FIELD", field: "granularity", value: val });
        }}
      />
      <GranularityPicker
        granularity={props.granularity}
        setGranularity={(val: any) => {
          dispatch({ type: "UPDATE_FIELD", field: "granularity", value: val });
        }}
      />
    </>
  );
};
