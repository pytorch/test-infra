import { Card, CardContent, Grid, Typography } from "@mui/material";

export default function Page() {
  return (
    <div style={{ padding: 20 }}>
      <Card>
        <CardContent>
          <Grid container spacing={2}>
            <Grid>
              <Typography variant="h4" gutterBottom>
                Benchmark Regression Page Rendering Custommized Component
                Dynamically
              </Typography>
            </Grid>
          </Grid>
        </CardContent>
      </Card>
      <br />
    </div>
  );
}
