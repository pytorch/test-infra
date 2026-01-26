import { Box } from "@mui/system";
import { UMCopyLink } from "components/uiModules/UMCopyLink";
import { UMDateButtonPicker } from "components/uiModules/UMDateRangePicker";
import { UMPropReducer } from "components/uiModules/UMPropReducer";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { useRouter } from "next/router";
import { useEffect, useReducer } from "react";
import { ReportMetricsTable } from "./ReportMetricsTable";
import UtilizationReportProvider, {
  useUtilizationReportContext,
} from "./UtilizationReportContext";

dayjs.extend(utc);

const UtilizationReportPage = () => {
  const [timeRange, dispatch] = useReducer(UMPropReducer, {});

  const router = useRouter();
  useEffect(() => {
    const { start_time, end_time } = router.query;
    const newprops: any = {
      start_time,
      end_time,
    };
    dispatch({ type: "UPDATE_FIELDS", payload: newprops });
  }, [router.query]);

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
  return (
    <div>
      <Box
        sx={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 0.5,
        }}
      >
        <h2>Utilization Report Table: {values.group_by}</h2>{" "}
        <UMCopyLink
          params={values}
          excludeKeys={[
            "workflowNames",
            "jobNames",
            "machineTypes",
            "runnerLabels",
          ]}
        />
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
        start={dayjs.utc(timeRange.start_time)}
        end={dayjs.utc(timeRange.end_time)}
      />
      <ReportMetricsTable
        startTime={timeRange.start_time}
        endTime={timeRange.end_time}
      />
    </div>
  );
};

export default UtilizationReportPage;
