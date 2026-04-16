import { Alert, Box, styled } from "@mui/material";
import LoadingPage from "components/common/LoadingPage";
import ToggleIconPicker, {
  ToggleIconPickerContent,
} from "components/metrics/pickers/ToggleIconPicker";
import { useDarkMode } from "lib/DarkModeContext";
import { encodeParams, fetcherCatchErrorStatus } from "lib/GeneralUtils";
import { useState } from "react";
import { FcHeatMap } from "react-icons/fc";
import { MdOutlineStackedBarChart } from "react-icons/md";
import useSWRImmutable from "swr/immutable";
import { QueueTimeEchartElement } from "./QueueTimeEchartElement";

const FlexNoWrap = styled("div")({
  display: "flex",
  margin: "0",
  padding: "0",
});

const chartToggleList: ToggleIconPickerContent[] = [
  {
    icon: <MdOutlineStackedBarChart size={"2em"} />,
    tooltipContent: "Histogram chart",
    value: "histogram_bar_horizontal",
  },
  {
    icon: <FcHeatMap size={"2em"} />,
    tooltipContent: "Heatmap chart",
    value: "heatmap",
  },
];

export default function QueueTimeCharts({
  props,
  width = "100vw",
}: {
  props: any;
  width?: string;
}) {
  const [chartType, setChartType] = useState<any>("histogram_bar_horizontal");
  const { darkMode } = useDarkMode();

  const { data, error, isLoading } = useQueryWithError(props);
  if (isLoading) {
    return <LoadingPage height={700} width={width} />;
  }

  return (
    <div>
      <ToggleIconPicker
        toggleList={chartToggleList}
        type={chartType}
        setType={(val: any) => {
          setChartType(val);
        }}
      />
      {error && (error.status === 431 || error.status === 414) && (
        <Alert severity="error">
          {" "}
          Search Request failed with code: 431 Request header fields too large,
          please select less items in search.
        </Alert>
      )}
      {renderCharts(chartType, data, props, width)}
    </div>
  );
}

function renderCharts(chartType: string, data: any, props: any, width: any) {
  switch (chartType) {
    case "heatmap":
      return (
        <FlexNoWrap sx={{ width: width }}>
          <QueueTimeEchartElement
            data={data}
            granularity={props.granularity}
            chartType={chartType}
            width={`70%`}
            height={"60vh"}
            minWidth={`200px`}
          />
          <QueueTimeEchartElement
            data={data}
            granularity={props.granularity}
            chartType={"histogram_bar_vertical"}
            width={"20%"}
            height={"60vh"}
            minWidth="100px"
          />
        </FlexNoWrap>
      );
    case "histogram_bar_horizontal":
      const subcharts = [
        "max_queue_time_line",
        "avg_queue_time_line",
        "p50_queue_time_line",
        "percentile_queue_time_lines",
        "avg_queued_jobs_count_line",
      ];
      if (!subcharts) {
        return <></>;
      }
      return (
        <>
          <FlexNoWrap sx={{ width: width }}>
            <QueueTimeEchartElement
              data={data}
              granularity={props.granularity}
              chartType={chartType}
              width={`100%`}
              height={"60vh"}
              minWidth={`300px`}
            />
          </FlexNoWrap>
          <Box sx={{ width: width, display: "flex", flexWrap: "wrap" }}>
            {subcharts.map((sub) => {
              return (
                <Box key={sub} sx={{ width: "45%" }}>
                  <div> {sub.replaceAll("_", " ")} </div>
                  <QueueTimeEchartElement
                    data={data}
                    granularity={props.granularity}
                    chartType={sub}
                    chartGroup="stats_line_group"
                    width={`100%`}
                    height={"30vh"}
                    minWidth={`200px`}
                  />
                </Box>
              );
            })}
          </Box>
        </>
      );
    default:
      return (
        <FlexNoWrap sx={{ width: width }}>
          <QueueTimeEchartElement
            data={data}
            granularity={props.granularity}
            chartType={chartType}
            width={`100%`}
            height={"60vh"}
            minWidth={`300px`}
          />
        </FlexNoWrap>
      );
  }
}

function useQueryWithError(props: any) {
  const category = props.category ? props.category : "workflow_name";
  const params = {
    startTime: props.startDate?.utc().format("YYYY-MM-DDTHH:mm:ss"),
    endTime: props.endDate?.utc().format("YYYY-MM-DDTHH:mm:ss"),
    repos: props.repos,
    granularity: props.granularity ? props.granularity : "",
    workflowNames: props.workflowNames ? props.workflowNames : [],
    jobNames: props.jobNames ? props.jobNames : [],
    machineTypes: props.machineTypes ? props.machineTypes : [],
    runnerLabels: props.runnerLabels ? props.runnerLabels : [],
  };

  const queryName = `queue_time_analysis/queue_time_query`;
  const url = `/api/clickhouse/${encodeURIComponent(queryName)}?${encodeParams({
    parameters: JSON.stringify(params),
  })}`;

  return useSWRImmutable(url, fetcherCatchErrorStatus);
}
