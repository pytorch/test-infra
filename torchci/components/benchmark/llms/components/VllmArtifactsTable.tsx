import {
  Alert,
  Box,
  CircularProgress,
  Link,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useArtifacts } from "lib/benchmark/llms/utils/artifacts";

export function VllmArtifactsTable() {
  const { data, error, isLoading } = useArtifacts({
    prefix: "vllm-project/vllm/",
  });

  if (error) {
    return (
      <Alert severity="error" sx={{ mt: 2 }}>
        Unable to load recent vLLM trace artifacts.
      </Alert>
    );
  }

  if (isLoading) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mt: 2 }}>
        <CircularProgress size={20} />
        <Typography variant="body2">Loading vLLM trace artifacts…</Typography>
      </Box>
    );
  }

  const files = data?.files ?? [];

  if (files.length === 0) {
    return (
      <Typography variant="body2" sx={{ mt: 2 }}>
        No vLLM trace artifacts were found in the last six months.
      </Typography>
    );
  }

  return (
    <Box sx={{ mt: 4 }}>
      <Typography variant="h6" sx={{ mb: 1 }}>
        Recent vLLM trace artifacts
      </Typography>
      <TableContainer
        component={Paper}
        sx={{ maxHeight: 440, margin: "10px 0", tableLayout: "auto" }}
      >
        <Table size="small" stickyHeader aria-label="vLLM artifacts">
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: "10%", py: 0.5 }}>
                Serial number
              </TableCell>
              <TableCell sx={{ width: "20%", py: 0.5 }}>Date</TableCell>
              <TableCell sx={{ width: "30%", py: 0.5 }}>Model name</TableCell>
              <TableCell sx={{ width: "40%", py: 0.5 }}>
                Name of the file
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {files.map((file, index) => (
              <TableRow key={file.key} hover>
                <TableCell sx={{ py: 0.5 }}>{index + 1}</TableCell>
                <TableCell sx={{ py: 0.5 }}>{file.date || "—"}</TableCell>
                <TableCell sx={{ py: 0.5, wordBreak: "break-word" }}>
                  {file.modelName || "—"}
                </TableCell>
                <TableCell sx={{ py: 0.5, wordBreak: "break-word" }}>
                  <Link
                    href={file.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    underline="hover"
                  >
                    {file.fileName || file.key}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
