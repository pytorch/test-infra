import { Box } from "@mui/system";
import { UMDateButtonPicker } from "components/uiModules/UMDateRangePicker";
import { UMPropReducer } from "components/uiModules/UMPropReducer";
import { UMSymlink } from "components/uiModules/UMSymlink";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { useEffect, useReducer, useState } from "react";
import { objectToQueryString } from "./hepler";
import { ReportMetricsTable } from "./ReportMetricsTable";
import UtilizationReportProvider, {
  useUtilizationReportContext,
} from "./UtilizationReportContext";
import CopyLink from "components/CopyLink";
import router, { useRouter } from "next/router";
import { UMCopySymLink } from "components/uiModules/UMSymbLink";

dayjs.extend(utc);
const UtilizationReportPage = () => {
  const [timeRange, dispatch] = useReducer(UMPropReducer, {});

  const router = useRouter();
  useEffect(() => {
    const {
      start_time = dayjs.utc().format("YYYY-MM-DD"),
      end_time =  dayjs.utc().format("YYYY-MM-DD"),
     } = router.query;
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
        <h2>Utilization Report Table: {values.group_by}</h2>{" "} <UMCopySymLink params={values} />
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
