import { DataGrid } from "@mui/x-data-grid";
import LoadingPage from "components/LoadingPage";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { fetcher } from "lib/GeneralUtils";
import { ListUtilizationReportAPIResponse } from "lib/utilization/types";
import { useRouter } from "next/router";
import useSWR from "swr";

dayjs.extend(utc);

const WorkflowUtilization = () => {
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

  const metricsKeys = Array.from(
    new Set(data.list.flatMap((job) => Object.keys(job?.metrics || {})))
  );

  const rows = data.list.map((item) => {
    const { group_key, parent_group, time_group, total_runs, metrics } = item;
    return {
      id: `${group_key}|${parent_group}|${time_group}`,
      counts: total_runs,
      name: group_key,
      time: time_group,
      ...metrics,
    };
  });

  const columns: any[] = [
    { field: "name", headerName: "Job Name", width: 400 },
    { field: "counts", headerName: "Detected # of runs", width: 120 },
    { field: "time", headerName: "time", width: 120 },
    ...metricsKeys.map((key) => ({
      field: key,
      headerName: key,
      width: 120,
      renderCell: (params: any) => {
        let bgColor = "";
        if (typeof params.value === "number") {
          bgColor = params.value > 60 ? "#ffdddd" : "";
          return (
            <div
              style={{
                width: "100%",
                height: "100%",
                backgroundColor: bgColor,
                display: "flex",
                alignItems: "center",
                paddingLeft: 8,
              }}
            >
              {Number(params.value).toFixed(2)}%
            </div>
          );
        }

        if (typeof params.value === "boolean") {
          return <div>{params.value ? "Yes" : "No"}</div>;
        }
        return <div>{params.formattedValue}</div>;
      },
    })),
  ];

  return (
    <div>
      <div>Utilization Reports: </div>
      <h2> Utilization Summary Table</h2>
      <span>Utilization metrics above 60% is highlighted</span>
      <div style={{ height: "1000px", width: "100%" }}>
        <DataGrid rows={rows} columns={columns} pageSizeOptions={[90]} />
      </div>
    </div>
  );
};
export default WorkflowUtilization;

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

  console.log(JSON.stringify(params));
  console.log(url);

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
