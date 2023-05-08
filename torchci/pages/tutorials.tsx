import { Grid, Typography, Stack } from "@mui/material";
import TablePanel from "components/metrics/panels/TablePanel";

const ROW_HEIGHT = 600;

export default function Page() {
  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          PyTorch Tutorials Metrics
        </Typography>
      </Stack>
      <Grid item xs={6} height={ROW_HEIGHT}>
        <TablePanel
          title={"Last Updated Tutorials"}
          queryCollection={"commons"}
          queryName={"last_updated_tutorials"}
          queryParams={[]}
          columns={[
            { field: "filename", headerName: "Filename", flex: 4 },
            {
              field: "last_updated",
              headerName: "Last Updated",
              flex: 1,
              valueFormatter: (params) => params.value.value,
            },
          ]}
          dataGridProps={{
            getRowId: (e: any) => e.filename + e.last_updated,
            initialState: {
              columns: {
                columnVisibilityModel: {
                  job_name: false,
                },
              },
            },
          }}
        />
      </Grid>
    </div>
  );
}
