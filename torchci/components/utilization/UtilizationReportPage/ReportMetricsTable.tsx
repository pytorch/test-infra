import { Box } from "@mui/system";
import LoadingPage from "components/LoadingPage";
import UMMetricsTable, {
  UMMetricsTableUserMappingEntry,
} from "components/uiModules/UMMetricsTable";
import { UMPropReducer } from "components/uiModules/UMPropReducer";
import dayjs from "dayjs";
import { useRouter } from "next/router";
import { ParsedUrlQuery } from "querystring";
import { useEffect, useReducer } from "react";
import { objectToQueryString, useUtilReports } from "./hepler";
import { useUtilizationReportContext } from "./UtilizationReportContext";

type ReportMetricsTableProps = {
  startTime: string;
  endTime: string;
};

export function ReportMetricsTable({
  startTime,
  endTime,
}: ReportMetricsTableProps) {
  const userMapping: { [key: string]: UMMetricsTableUserMappingEntry } = {
    key: {
      custom_field_expression: "${group_key}|${parent_group}|${time_group}",
      value_type: "string",
      visible: false,
    },
    name: {
      field: "group_key",
      headerName: "name",
      value_type: "string",
      width: 400,
    },
    counts: {
      field: "total_runs",
      headerName: "detected # of runs",
      value_type: "number",
    },
    parent: {
      field: "parent_group",
      headerName: "parent",
      value_type: "string",
    },
    time: {
      field: "time_group",
      value_type: "string",
      headerName: "date",
    },
    metrics: {
      field: "metrics",
      visible: false,
      value_type: "list",
      unit: "%",
    },
  };

  const router = useRouter();
  const [props, dispatch] = useReducer(UMPropReducer, {});
  const { updateFields } = useUtilizationReportContext();

  useEffect(() => {
    const rQuery = router.query as ParsedUrlQuery;
    const {
      start_time = dayjs.utc().format("YYYY-MM-DD"),
      end_time = dayjs.utc().format("YYYY-MM-DD"),
      parent_group,
      group_by = "workflow_name",
    } = rQuery;

    const newprops: any = {
      repo: "pytorch/pytorch",
      granularity: "all",
      start_time: start_time,
      end_time: end_time,
      group_by: group_by,
      parent_group: parent_group,
    };
    dispatch({ type: "UPDATE_FIELDS", payload: newprops });
    const { granularity, ...withoutGranularity } = newprops;
    updateFields(withoutGranularity);
  }, [router.query]);

  useEffect(() => {
    let newprops: any = props;
    if (startTime && startTime != props.start_time) {
      newprops = {
        ...newprops,
        start_time: startTime,
      };
    }

    if (endTime && endTime != props.end_time) {
      newprops = {
        ...newprops,
        end_time: endTime,
      };
    }
    dispatch({ type: "UPDATE_FIELDS", payload: newprops });

    const { granularity, ...withoutGranularity } = newprops;
    updateFields(withoutGranularity);
  }, [startTime, endTime]);

  const data = useUtilReports(props);
  if (!data || !props) {
    return <LoadingPage />;
  }

  let tableConfig = userMapping;

  if (props.group_by == "workflow_name") {
    const url = `/utilization/report?group_by=job_name&${objectToQueryString(
      props,
      ["group_by"]
    )}&parent_group=\$\{parent_group\}|\$\{group_key\}`;

    tableConfig = {
      ...userMapping,
      link: {
        custom_field_expression: "job report link",
        headerName: "job report",
        value_type: "link",
        link_url: url,
      },
    };
  }
  if (!data) {
    return <LoadingPage />;
  }
  const tableData = data.list;
  return (
    <div>
      <UMMetricsTable userMapping={tableConfig} data={tableData} />
      <Box
        sx={{
          fontSize: "0.5rem",
        }}
      >
        * detected data from {data.min_time} to {data.max_time}
      </Box>
    </div>
  );
}
