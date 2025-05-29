import { Box } from "@mui/system";
import { UMDateButtonPicker } from "components/uiModules/UMDateRangePicker";
import { UMPropReducer } from "components/uiModules/UMPropReducer";
import { UMSymlink } from "components/uiModules/UMSymlink";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { useEffect, useReducer } from "react";
import { objectToQueryString } from "./hepler";
import { ReportMetricsTable } from "./ReportMetricsTable";
import UtilizationReportProvider, {
  useUtilizationReportContext,
} from "./UtilizationReportContext";

dayjs.extend(utc);
const UtilizationReportPage = () => {
  const [timeRange, dispatch] = useReducer(UMPropReducer, {});

  useEffect(() => {
    const newprops: any = {
      start_time: dayjs.utc().format("YYYY-MM-DD"),
      end_time: dayjs.utc().format("YYYY-MM-DD"),
    };
    dispatch({ type: "UPDATE_FIELDS", payload: newprops });
  }, []);

  return (
    <UtilizationReportProvider>
      <InnerUtilizationContent timeRange={timeRange} dispatch={dispatch} />
    </UtilizationReportProvider>
  );
};

const InnerUtilizationContent = ({
  timeRange,
  dispatch,
}: {
  timeRange: any;
  dispatch: React.Dispatch<any>;
}) => {
  const { values } = useUtilizationReportContext();
  const symlink = `/utilization/report?${objectToQueryString(values)}`;
  return (
    <div>
      <div>useUtilizationReportContext: {JSON.stringify(values)}</div>
      <Box
        sx={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 0.5,
        }}
      >
        <h2>Utilization Report Table: {values.group_by}</h2>{" "}
        <UMSymlink target={symlink} />
      </Box>

      <UMDateButtonPicker
        setTimeRange={(start: dayjs.Dayjs, end: dayjs.Dayjs) => {
          const newprops: any = {
            ...timeRange,
            start_time: start.format("YYYY-MM-DD"),
            end_time: end.format("YYYY-MM-DD"),
          };
          dispatch({
            type: "UPDATE_FIELDS",
            payload: newprops,
          });
        }}
        start={timeRange.start_time}
        end={timeRange.end_time}
      />
      <ReportMetricsTable
        startTime={timeRange.start_time}
        endTime={timeRange.end_time}
      />
    </div>
  );
};

export default UtilizationReportPage;
