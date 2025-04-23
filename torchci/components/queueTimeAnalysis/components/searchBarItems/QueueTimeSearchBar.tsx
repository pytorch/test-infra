import { Button, styled } from "@mui/material";
import { propsReducer } from "components/benchmark/llms/context/BenchmarkProps";
import { DateRangePicker } from "components/queueTimeAnalysis/components/pickers/DateRangePicker";
import { TimeGranuityPicker } from "components/queueTimeAnalysis/components/pickers/TimeGranuityPicker";
import dayjs from "dayjs";
import { cloneDeep } from "lodash";
import { NextRouter } from "next/router";
import { ParsedUrlQuery } from "querystring";
import { useEffect, useReducer } from "react";
import DebugToggle from "../DebugToggle";
import QueueTimeCheckBoxList from "./QueueTimeCheckBoxList";

export const HorizontalDiv = styled("div")({
  display: "flex",
  margin: "5px",
  padding: "10px 0",
  overflowX: "hidden",
});

export const GapItem = styled("div")({
  margin: "10px",
  padding: "2px",
});

function splitString(input: string | string[]): string[] {
  if (Array.isArray(input)) {
    // Join the array into a single string, separating elements with a comma
    return input;
  }
  // If it's already a string, return it as is
  return input.split(",");
}

export interface QueueTimeSearchBarOptions {
  dateRange: number;
  startDate: dayjs.Dayjs;
  endDate: dayjs.Dayjs;
  granularity: string;
  chartType: string;
  repos: string[];
  category: string;
  items?: string[];
}

export default function QueueTimeSearchBar({
  router,
  updateSearch,
}: {
  router: NextRouter;
  updateSearch: React.Dispatch<any>;
}) {
  const toHalfHourDayJs = (dateString: string) => {
    const date = dayjs(dateString as string).utc();
    const minutes = date.minute();
    const halfHourStart = date
      .minute(minutes < 30 ? 0 : 30)
      .second(0)
      .millisecond(0);
    return halfHourStart;
  };

  // local state handle changes
  const [props, dispatch] = useReducer(propsReducer, null);
  useEffect(() => {
    const rQuery = router.query as ParsedUrlQuery;
    const newprops = {
      dateRange: rQuery.dateRange
        ? parseInt(rQuery.dateRange as string)
        : rQuery.startDate || rQuery.endDate
        ? -1
        : 3,
      startDate: rQuery.startDate
        ? toHalfHourDayJs(rQuery.startDate as string)
        : rQuery.dateRange
        ? toHalfHourDayJs(dayjs().format()).subtract(
            parseInt(rQuery.dateRange as string),
            "day"
          )
        : toHalfHourDayJs(dayjs().format()).subtract(3, "day"),
      endDate: rQuery.endDate
        ? toHalfHourDayJs(rQuery.endDate as string)
        : toHalfHourDayJs(dayjs().format()),
      granularity: (rQuery.granularity as string) || "hour",
      chartType: (rQuery.chartType as string) || "bar",
      repos: rQuery.repos
        ? splitString(rQuery.repos as string)
        : ["pytorch/pytorch"],
      category: rQuery.category ? (rQuery.category as string) : "workflow_name",
      items: rQuery.items ? splitString(rQuery.items as string) : null, // if items is not specified, it will fetch all items belongs to category
    };
    updateSearch({ type: "UPDATE_FIELDS", payload: newprops });
    dispatch({ type: "UPDATE_FIELDS", payload: newprops });
  }, [router.query]);

  if (!props) {
    return <></>;
  }
  const onSearch = () => {
    const newprops = cloneDeep(props);
    updateSearch({ type: "UPDATE_FIELDS", payload: newprops });
  };

  return (
    <>
      <GapItem>
        <Button variant="contained" onClick={onSearch}>
          Search
        </Button>
      </GapItem>
      <HorizontalDiv>
        <DateRangePicker
          startDate={props.startDate}
          setStartDate={(val: any) => {
            dispatch({ type: "UPDATE_FIELD", field: "startDate", value: val });
          }}
          stopDate={props.endDate}
          setStopDate={(val: any) => {
            dispatch({ type: "UPDATE_FIELD", field: "stopDate", value: val });
          }}
          dateRange={props.dateRange}
          setDateRange={(val: any) => {
            dispatch({ type: "UPDATE_FIELD", field: "dateRange", value: val });
          }}
          setGranularity={(val: any) => {
            dispatch({
              type: "UPDATE_FIELD",
              field: "granularity",
              value: val,
            });
          }}
        />
        <TimeGranuityPicker
          granularity={props.granularity}
          setGranularity={(val: any) => {
            dispatch({
              type: "UPDATE_FIELD",
              field: "granularity",
              value: val,
            });
          }}
        />
      </HorizontalDiv>
      <div>
        <QueueTimeCheckBoxList
          inputCategory={props.category}
          inputItems={props.items}
          startDate={props.startDate}
          endDate={props.endDate}
          updateFields={(val: any) => {
            dispatch({ type: "UPDATE_FIELDS", payload: val });
          }}
        />
      </div>
      <DebugToggle info={props} />
    </>
  );
}
