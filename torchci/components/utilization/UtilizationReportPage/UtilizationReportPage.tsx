import { DataGrid } from "@mui/x-data-grid";
import LoadingPage from "components/LoadingPage";
import MetricsTable from "components/uiModules/MetricsTable";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { fetcher } from "lib/GeneralUtils";
import { ListUtilizationReportAPIResponse } from "lib/utilization/types";
import { useRouter } from "next/router";
import useSWR from "swr";

dayjs.extend(utc);


const userMapping: {[key:string ]:any} = {
  "key": {
    custom_field_expression: "${group_key}|${parent_group}|${time_group}",
    value_type: "string",
    visible: false,
  },
  "name":{
    field:"group_key",
    headerName:"name",
    value_type: "string",
  },
  "counts": {
    field:"total_runs",
    headerName:"detected # of runs",
    value_type: "number",
  },
  "parent":{
    field:"parent_group",
    headerName:"prefix",
    value_type: "string",
  },
  "time":{
    field:"time_group",
    value_type: "string",
    headerName:"date",
  },
  "metrics":{
    field:"metrics",
    visible:false,
    value_type:"list",
  }
};



const UtilizationReport = () => {
  const router = useRouter();
  const {
    group_by,
    granularity = "day",
    start_time = dayjs.utc().format("YYYY-MM-DD"),
    end_time = dayjs.utc().format("YYYY-MM-DD"),
  } = router.query;
  const params: any = {
    repo: "pytorch/pytorch",
    group_by: group_by,
    granularity: granularity,
    start_time: start_time,
    end_time: end_time,
  };

  const data = useUtilReports(params);
  if (!data) {
    return <LoadingPage />;
  }

  console.log("data",data)

  return (
    <div>
      <h2> Utilization Report Table: {params.group_by}</h2>
      <span>Utilization metrics above 60% is highlighted</span>
      <MetricsTable userMapping={userMapping} data={data.list}/>
    </div>
  );
};
export default UtilizationReport;

function useUtilReports(params: any): {
  list: any[];
  metaError: any;
} {
  const queryParams = new URLSearchParams({
    repo: params.repo,
    group_by: params.group_by,
    granularity: params.granularity || "day",
    start_time: params.start_time || "2025-05-08",
    end_time: params.end_time || "2025-05-08",
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
