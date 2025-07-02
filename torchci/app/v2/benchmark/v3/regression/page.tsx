import { Card, CardContent, Grid2, Typography } from "@mui/material";

export default function Page() {
  return (
    <div style={{ padding: 20 }}>
      <Card>
        <CardContent>
          <Grid2 container spacing={2}>
            <Grid2>
              <Typography variant="h4" gutterBottom>
                Benchmark Regression Page Rendering Custommized Component
                Dynamically
              </Typography>
            </Grid2>
          </Grid2>
        </CardContent>
      </Card>
      <br />
    </div>
  );
}
