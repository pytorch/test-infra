import LoadingPage from "components/LoadingPage";
import MetricsTable, {
  MetricsTableUserMappingEntry,
} from "components/uiModules/MetricsTable";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { fetcher } from "lib/GeneralUtils";
import { ListUtilizationReportAPIResponse } from "lib/utilization/types";
import { useRouter } from "next/router";
import useSWR from "swr";

dayjs.extend(utc);

const userMapping: { [key: string]: MetricsTableUserMappingEntry } = {
  key: {
    custom_field_expression: "${group_key}|${parent_group}|${time_group}",
    value_type: "string",
    visible: false,
  },
  name: {
    field: "group_key",
    headerName: "name",
    value_type: "string",
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

const UtilizationReport = () => {
  const router = useRouter();
  const {
    group_by,
    granularity = "day",
    start_time = dayjs.utc().format("YYYY-MM-DD"),
    end_time = dayjs.utc().format("YYYY-MM-DD"),
    parent_group,
  } = router.query;
  const params: any = {
    repo: "pytorch/pytorch",
    group_by: group_by,
    granularity: granularity,
    start_time: start_time,
    end_time: end_time,
    parent_group: parent_group,
  };

  const data = useUtilReports(params);

  let tableConfig = userMapping;

  if (group_by == "workflow_name") {
    const url = `/utilization/report?group_by=job_name&${objectToQueryString(
      params,
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

  return (
    <div>
      <h2> Utilization Report Table: {params.group_by}</h2>
      <MetricsTable userMapping={tableConfig} data={data.list} />
    </div>
  );
};
export default UtilizationReport;

function useUtilReports(params: any): {
  list: any[];
  metaError: any;
} {
  const nowDateString = dayjs.utc().format("YYYY-MM-DD");
  const queryParams = new URLSearchParams({
    repo: params.repo,
    group_by: params.group_by,
    granularity: params.granularity || "day",
    start_time: params.start_time || nowDateString,
    end_time: params.end_time || nowDateString,
    parent_group: params.parent_group || "",
  });

  const url = `/api/list_util_reports/${
    params.group_by
  }?${queryParams.toString()}`;

  const { data, error } = useSWR<ListUtilizationReportAPIResponse>(
    url,
    fetcher
  );

  if (error != null) {
    return {
      list: [],
      metaError: "Error occured while fetching util metadata",
    };
  }

  if (data == null) {
    return { list: [], metaError: "Loading..." };
  }

  if (data.metadata_list == null) {
    return { list: [], metaError: "No metadata list found" };
  }

  return { list: data.metadata_list, metaError: null };
}

function objectToQueryString(
  obj: Record<string, any>,
  excludeKeys: string[] = []
): string {
  const excludeSet = new Set(excludeKeys);
  return new URLSearchParams(
    Object.entries(obj).filter(
      ([key, value]) =>
        !excludeSet.has(key) && value !== undefined && value !== null
    )
  ).toString();
}
