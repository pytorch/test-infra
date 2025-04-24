import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { Box, IconButton, styled } from "@mui/material";
import { propsReducer } from "components/benchmark/llms/context/BenchmarkProps";
import { DateRangePicker } from "components/queueTimeAnalysis/components/pickers/DateRangePicker";
import { TimeGranuityPicker } from "components/queueTimeAnalysis/components/pickers/TimeGranuityPicker";
import dayjs from "dayjs";
import { cloneDeep } from "lodash";
import { NextRouter } from "next/router";
import { ParsedUrlQuery } from "querystring";
import { useEffect, useReducer, useState } from "react";
import DebugToggle from "../DebugToggle";
import QueueTimeCheckBoxList from "./QueueTimeCheckBoxList";
import { RainbowScrollStyle } from "./SharedUIElements";

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

export const HorizontalDiv = styled("div")({
  display: "flex",
  margin: "5px",
  padding: "10px 0",
  overflowX: "hidden",
});

const SearchConfiguration = styled(Box)({
  position: "fixed",
  top: 70,
  right: 0,
  height: "100vh",
  boxShadow: "0px 2px 8px rgba(0,0,0,0.1)", // replace boxShadow: 4
  zIndex: 1000,
  borderTopLeftRadius: 8,
  borderBottomLeftRadius: 8,
  display: "flex",
  flexDirection: "row",
});

const ToggleButtonBox = styled(Box, {
  shouldForwardProp: (prop) => prop !== "open",
})(({ theme, open }: { theme: any; open: boolean }) => ({
  width: 40,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderLeft: open ? "1px solid #ccc" : "none",
  borderTopLeftRadius: open ? 8 : 0,
  borderBottomLeftRadius: open ? 8 : 0,
}));

const ScrollBarLeft = styled(Box)(({ theme }) => ({
  ...RainbowScrollStyle,
  overflowY: "auto",
  direction: "rtl",
  width: "20vw",
  minWidth: "200px",
  padding: "0  20px",
}));

const SearchFilters = styled(Box)(({ theme }) => ({
  direction: "ltr",
  padding: "0  10px 0  0",
  overflowY: "auto",
  zIndex: 2000,
}));

export const SearchButton = styled("div")(({ theme }) => ({
  margin: "10px",
  padding: "2px",
  position: "sticky",
  top: 0,
  zIndex: 10,
  textAlign: "left",
  width: "100%",
}));

const RainbowButton = styled(Box)(() => ({
  background: "linear-gradient(90deg, #ffb6c1, #add8e6)", // light pink to light blue
  color: "#333", // soft dark for readability
  fontWeight: 600,
  textTransform: "none",
  padding: "10px 20px",
  borderRadius: "12px",
  boxShadow: "0 2px 6px rgba(0,0,0,0.1)",
  transition: "all 0.3s ease",
  "&:hover": {
    background: "linear-gradient(90deg, #ff9eb6, #9dd3f3)",
    boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
  },
}));

export default function QueueTimeSearchBar({
  router,
  updateSearch,
  setToggle = () => {},
}: {
  router: NextRouter;
  updateSearch: React.Dispatch<any>;
  setToggle: any;
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

  const [open, setOpen] = useState(true);

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

  const onSearch = () => {
    const newprops = cloneDeep(props);
    updateSearch({ type: "UPDATE_FIELDS", payload: newprops });
  };

  if (!props) {
    return <></>;
  }

  return (
    <SearchConfiguration>
      {/* toggle button */}
      <ToggleButtonBox open={open} theme={undefined}>
        <IconButton
          size="small"
          onClick={() => {
            setOpen(!open);
            setToggle(!open);
          }}
        >
          {open ? <ChevronRightIcon /> : <ChevronLeftIcon />}
        </IconButton>
      </ToggleButtonBox>
      {open && (
        <ScrollBarLeft>
          <SearchButton>
            <RainbowButton onClick={onSearch}>Search</RainbowButton>
            <Box sx={{ borderBottom: "1px solid #eee", padding: "10px 0" }} />
          </SearchButton>
          <SearchFilters>
            <HorizontalDiv>
              <DateRangePicker
                startDate={props.startDate}
                setStartDate={(val: any) => {
                  dispatch({
                    type: "UPDATE_FIELD",
                    field: "startDate",
                    value: val,
                  });
                }}
                stopDate={props.endDate}
                setStopDate={(val: any) => {
                  dispatch({
                    type: "UPDATE_FIELD",
                    field: "stopDate",
                    value: val,
                  });
                }}
                dateRange={props.dateRange}
                setDateRange={(val: any) => {
                  dispatch({
                    type: "UPDATE_FIELD",
                    field: "dateRange",
                    value: val,
                  });
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
          </SearchFilters>
        </ScrollBarLeft>
      )}
    </SearchConfiguration>
  );
}
