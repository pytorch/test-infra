import { Card, CardContent, Grid, Typography } from "@mui/material";

export default function Page() {
  const list = ["torhchAo", "vllm", "torch compiler"];
  return (
    <div style={{ padding: 20 }}>
      <Typography variant="h4" gutterBottom>
        Benchmarks
      </Typography>
      <Grid container spacing={2}>
        {list.map((item, index) => (
          <Grid key={index}>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="h6" component="div">
                  {item}
                </Typography>
                <Typography color="text.secondary">
                  Benchmark description for {item}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>
    </div>
  );
}
