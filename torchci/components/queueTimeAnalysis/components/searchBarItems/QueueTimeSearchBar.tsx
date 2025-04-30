import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { Box, FormHelperText, IconButton, Paper, styled } from "@mui/material";
import { propsReducer } from "components/benchmark/llms/context/BenchmarkProps";
import { DateRangePicker } from "components/queueTimeAnalysis/components/pickers/DateRangePicker";
import { TimeGranuityPicker } from "components/queueTimeAnalysis/components/pickers/TimeGranuityPicker";
import dayjs from "dayjs";
import { cloneDeep } from "lodash";
import { NextRouter } from "next/router";
import { ParsedUrlQuery } from "querystring";
import { useEffect, useReducer, useState } from "react";
import QueueTimeCheckBoxList from "./QueueTimeCheckBoxList";
import {
  DropboxSelectDense,
  FlexDiv,
  FontSizeStyles,
  RainbowScrollStyle,
} from "./SharedUIElements";

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
  padding: "10px 0",
  overflowX: "hidden",
  justifyContent: "fl",
  margin: "0 0 5px 0",
});

const SearchConfiguration = styled(Paper)({
  position: "fixed",
  top: 70,
  right: 0,
  height: "100%",
  boxShadow: "0px 2px 8px rgba(0,0,0,0.1)",
  zIndex: 1000,
  borderTopLeftRadius: 8,
  borderBottomLeftRadius: 8,
  display: "flex",
});

const ToggleButtonBox = styled(Box, {
  shouldForwardProp: (prop) => prop !== "open",
})(({ theme, open }: { theme: any; open: boolean }) => ({
  width: 30,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderLeft: open ? "1px solid #ccc" : "none",
  borderTopLeftRadius: open ? 8 : 0,
  borderBottomLeftRadius: open ? 8 : 0,
}));

const ScrollBar = styled(Box)(({ theme }) => ({
  ...RainbowScrollStyle,
  overflowX: "hidden",
  overflowY: "auto",
  height: "auto",
  width: "20vw",
  minWidth: "200px",
  margin: "40px",
  padding: "0 0 80px 0",
}));

const SearchFilters = styled(Box)(({ theme }) => ({
  direction: "ltr",
  padding: "0  10px 0  0",
  overflowY: "auto",
  zIndex: 2000,
}));

export const SearchButton = styled(Paper)(({ theme }) => ({
  flex: 1,
  flexShrink: 0,
  border: "none",
  padding: "0",
  margin: "0",
  boxShadow: "none",
  position: "sticky",
  bottom: 0,
  zIndex: 10,
  textAlign: "left",
  width: "100%",
}));

const RainbowButton = styled(Box)(() => ({
  background: "linear-gradient(90deg, #ffb6c1, #add8e6)", // light pink to light blue
  color: "#333", // soft dark for readability
  fontWeight: 600,
  width: "60%",
  margin: "5px",
  textTransform: "none",
  padding: "10px 20px",
  borderRadius: "12px",
  boxShadow: "0 2px 6px rgba(0,0,0,0.1)",
  transition: "all 0.3s ease",
  "&:hover": {
    background: "linear-gradient(90deg, #ff9eb6, #9dd3f3)",
    boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
  },
  display: "flex",
  justifyContent: "center",
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
      granularity: (rQuery.granularity as string) || "half_hour",
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
        <FlexDiv>
          <ScrollBar>
            <SearchFilters>
              <HorizontalDiv>
                <DateRangePicker
                  sx={{
                    ...DropboxSelectDense,
                    ...FontSizeStyles,
                  }}
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
                  sx={{
                    ...DropboxSelectDense,
                    ...FontSizeStyles,
                  }}
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
            </SearchFilters>
          </ScrollBar>
          <SearchButton>
            <Box sx={{ borderBottom: "1px solid #eee", padding: "0 0" }} />
            <RainbowButton onClick={onSearch}>Search</RainbowButton>
            <FormHelperText>
              <span style={{ color: "red" }}>*</span> Click to apply filter
              changes
            </FormHelperText>
          </SearchButton>
        </FlexDiv>
      )}
    </SearchConfiguration>
  );
}
