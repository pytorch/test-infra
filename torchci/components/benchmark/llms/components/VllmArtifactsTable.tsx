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
import { useVllmArtifacts } from "lib/benchmark/llms/utils/vllmArtifacts";

export function VllmArtifactsTable() {
  const { data, error, isLoading } = useVllmArtifacts();

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
    <Box sx={{ mt: 2 }}>
      <Typography variant="h6" sx={{ mb: 1 }}>
        Recent vLLM trace artifacts
      </Typography>
      <TableContainer component={Paper} sx={{ maxHeight: 400 }}>
        <Table size="small" stickyHeader aria-label="vLLM artifacts">
          <TableHead>
            <TableRow>
              <TableCell width="10%">Serial number</TableCell>
              <TableCell width="20%">Date</TableCell>
              <TableCell width="30%">Model name</TableCell>
              <TableCell width="40%">Name of the file</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {files.map((file, index) => (
              <TableRow key={file.key} hover>
                <TableCell>{index + 1}</TableCell>
                <TableCell>{file.date || "—"}</TableCell>
                <TableCell sx={{ wordBreak: "break-word" }}>
                  {file.modelName || "—"}
                </TableCell>
                <TableCell sx={{ wordBreak: "break-word" }}>
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
