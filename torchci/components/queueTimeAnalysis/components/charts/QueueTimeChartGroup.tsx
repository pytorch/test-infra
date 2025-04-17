import { Alert, styled } from "@mui/material";
import LoadingPage from "components/LoadingPage";
import ToggleIconPicker, {
  ToggleIconPickerContent,
} from "components/metrics/pickers/ToogleIconPicker";
import { encodeParams, fetcherCatchErrorStatus } from "lib/GeneralUtils";
import { useState } from "react";
import { BiLineChart } from "react-icons/bi";
import { FcHeatMap } from "react-icons/fc";
import { MdOutlineStackedBarChart } from "react-icons/md";
import useSWRImmutable from "swr/immutable";
import { QueueTimeChartUI } from "./QueueTimeChartUI";

const FlexNoWrap = styled("div")({
  display: "flex",
  margin: "0",
  padding: "0",
});

const chartToggleList: ToggleIconPickerContent[] = [
  {
    icon: <FcHeatMap size={"2em"} />,
    tooltipContent: "heatmap chart",
    value: "heatmap",
  },
  {
    icon: <MdOutlineStackedBarChart size={"2em"} />,
    tooltipContent: "histogram chart",
    value: "histogram_bar_horizontal",
  },
  {
    icon: <BiLineChart size={"2em"} />,
    tooltipContent: "count chart",
    value: "count_job_line",
  },
  {
    icon: <BiLineChart size={"2em"} />,
    tooltipContent: "max queue time chart",
    value: "max_queue_time_line",
  },
];

export default function QueueTimeChartGroup({ props }: { props: any }) {
  const [chartType, setChartType] = useState<any>("heatmap");

  const { data, error, isLoading } = useQueryWithError(props);
  if (isLoading) {
    return <LoadingPage height={1000} width={1600} />;
  }

  return (
    <>
      <ToggleIconPicker
        toggleList={chartToggleList}
        type={chartType}
        setType={(val: any) => {
          setChartType(val);
        }}
      />
      {error && error.status === 431 && (
        <Alert severity="error">
          {" "}
          Search Request failed with code: 431 Request header fields too large,
          please select less items in search
        </Alert>
      )}
      <FlexNoWrap>
        <QueueTimeChartUI
          data={data}
          granularity={props.granularity}
          chartType={chartType}
          chartGroup="test1"
          width={chartType === "heatmap" ? "1000px" : "1600px"}
        />
        {data && chartType === "heatmap" && (
          <QueueTimeChartUI
            data={data}
            granularity={props.granularity}
            chartType={"histogram_bar_vertical"}
            chartGroup="test1"
            width="600px"
          />
        )}
      </FlexNoWrap>
    </>
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
