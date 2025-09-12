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
import { UtilReportPageSyncParamsToUrl } from "./UtilReportPageSyncParamsToUrl";

dayjs.extend(utc);

const UtilizationReportPage = () => {
  const [timeRange, dispatch] = useReducer(UMPropReducer, {
    start_time: dayjs.utc(),
    end_time: dayjs.utc(),
  });

  const router = useRouter();
  useEffect(() => {
    const { start_time, end_time } = router.query;

    if (start_time && end_time) {
      const newprops: any = {
        start_time: dayjs.utc(start_time as string) || dayjs.utc(),
        end_time: dayjs.utc(end_time as string) || dayjs.utc(),
      };
      dispatch({ type: "UPDATE_FIELDS", payload: newprops });
    }
  }, [router.query]);

  return (
    <UtilizationReportProvider>
      <UtilReportPageSyncParamsToUrl />
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
            start_time: start,
            end_time: end,
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
        startTime={timeRange.start_time.format("YYYY-MM-DD")}
        endTime={timeRange.end_time.format("YYYY-MM-DD")}
      />
    </div>
  );
};

export default UtilizationReportPage;
