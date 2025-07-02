import {
  Card,
  CardContent,
  Grid2,
  Typography
} from "@mui/material";



export default function Page() {
  const list = ["torhchAo", "vllm", "torch compiler"];
  return (
    <div style={{ padding: 20 }}>
      <Typography variant="h4" gutterBottom>
        Benchmarks
      </Typography>
      <Grid2 container spacing={2}>
        {list.map((item, index) => (
          <Grid2 key={index}>
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
          </Grid2>
        ))}
      </Grid2>
    </div>
  );
}
