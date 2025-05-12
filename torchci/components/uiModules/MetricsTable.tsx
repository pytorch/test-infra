import { DataGrid } from "@mui/x-data-grid";

function generateStaticColumns(userMapping: { [key: string]: any }) {
  return Object.entries(userMapping)
    .filter(([, conf]) => conf.visible !== false)
    .map(([field, conf]) => ({
      field,
      headerName: conf.headerName ?? field,
      width: 120,
    }));
}

function extractMetricKeys(dataList: any[]): string[] {
  const metricKeys = new Set<string>();
  dataList.forEach((d) => {
    if (d.metrics && typeof d.metrics === "object") {
      Object.keys(d.metrics).forEach((k) => metricKeys.add(k));
    }
  });
  return Array.from(metricKeys);
}

// Assume data.list is your raw data
const resolveExpression = (expr: string, row: any): string =>
  expr.replace(/\${(.*?)}/g, (_, key) => row[key] ?? "");

function getRows(data: any, userMapping:{[key:string ]:any}){
  const rows = data.list.map((item: any, index: number) => {
    const row: any = { id: index }; // fallback id

    for (const [key, conf] of Object.entries(userMapping)) {
      if ("custom_field_expression" in conf) {
        row[key] = resolveExpression(conf.custom_field_expression, item);
      } else if (conf.field) {
        row[key] = item[conf.field];
      }
    }

    // Expand metrics if it's a nested object
    if (item.metrics && typeof item.metrics === "object") {
      for (const [k, v] of Object.entries(item.metrics)) {
        row[k] = v;
      }
    }
    return row;
  });
  return rows;
}

function generateMetricColumns(metricKeys: string[]) {
  return metricKeys.map((key) => ({
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
  }));
}

 export default function MetricsTable(userMapping: {[key:string ]:any}, data:any[]){
    const staticColumns = generateStaticColumns(userMapping);
    const metricKeys = extractMetricKeys(data);
    const metricColumns = generateMetricColumns(metricKeys);
    const columns = [...staticColumns, ...metricColumns];
    const rows = getRows(data,userMapping)

    return (
        <div style={{ height: "1000px", width: "100%" }}>
            <DataGrid rows={rows} columns={columns} pageSizeOptions={[90]} />
        </div>
    )
}
