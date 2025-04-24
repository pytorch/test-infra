import { Alert, styled } from "@mui/material";
import LoadingPage from "components/LoadingPage";
import ToggleIconPicker, {
  ToggleIconPickerContent,
} from "components/metrics/pickers/ToggleIconPicker";
import { useDarkMode } from "lib/DarkModeContext";
import { encodeParams, fetcherCatchErrorStatus } from "lib/GeneralUtils";
import { useState } from "react";
import { BiLineChart } from "react-icons/bi";
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
    icon: <FcHeatMap size={"2em"} />,
    tooltipContent: "Heatmap chart",
    value: "heatmap",
  },
  {
    icon: <MdOutlineStackedBarChart size={"2em"} />,
    tooltipContent: "Histogram chart",
    value: "histogram_bar_horizontal",
  },
  {
    icon: <BiLineChart size={"2em"} />,
    tooltipContent: "Count chart",
    value: "count_job_line",
  },
  {
    icon: <BiLineChart size={"2em"} />,
    tooltipContent: "Max queue time chart",
    value: "max_queue_time_line",
  },
];

export default function QueueTimeCharts({
  props,
  width = "100vw",
}: {
  props: any;
  width?: string;
}) {
  const [chartType, setChartType] = useState<any>("heatmap");
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
      <FlexNoWrap sx={{ width: width }}>
        <QueueTimeEchartElement
          data={data}
          granularity={props.granularity}
          chartType={chartType}
          width={chartType === "heatmap" ? `70%` : `100%`}
          height={"60vh"}
          minWidth={chartType === "heatmap" ? `200px` : `300px`}
        />
        {data && chartType === "heatmap" && (
          <QueueTimeEchartElement
            data={data}
            granularity={props.granularity}
            chartType={"histogram_bar_vertical"}
            width={"20%"}
            height={"60vh"}
            minWidth="100px"
          />
        )}
      </FlexNoWrap>
    </div>
  );
}

function useQueryWithError(props: any) {
  const category = props.category ? props.category : "workflow_name";
  const params = {
    startTime: props.startDate?.utc().format("YYYY-MM-DDTHH:mm:ss"),
    endTime: props.endDate?.utc().format("YYYY-MM-DDTHH:mm:ss"),
    items: props.items ? props.items : [],
    repos: props.repos,
    granularity: props.granularity ? props.granularity : "",
    workflowNames: [],
  };
  const queryName = `queue_time_analysis/queue_time_per_${category}`;
  const url = `/api/clickhouse/${encodeURIComponent(queryName)}?${encodeParams({
    parameters: JSON.stringify(params),
  })}`;

  return useSWRImmutable(url, fetcherCatchErrorStatus);
}
