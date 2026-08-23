import {
  Alert,
  Box,
  CircularProgress,
  Paper,
  Stack,
  Typography,
  useTheme,
} from "@mui/material";
import { decodeTestIdentity } from "lib/testIdentity";
import Head from "next/head";
import { useRouter } from "next/router";

export default function TestDetailsPage() {
  const router = useRouter();
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === "dark";
  const id = typeof router.query.id === "string" ? router.query.id : null;
  const test = id ? decodeTestIdentity(id) : null;
  const borderColor = isDarkMode
    ? theme.palette.grey[800]
    : theme.palette.grey[300];
  const labelColor = isDarkMode
    ? theme.palette.grey[400]
    : theme.palette.grey[700];

  if (!router.isReady) {
    return (
      <Stack
        alignItems="center"
        justifyContent="center"
        sx={{ minHeight: 320 }}
      >
        <CircularProgress />
      </Stack>
    );
  }

  if (!test) {
    return (
      <Box component="main" sx={{ maxWidth: 900, mx: "auto", p: 2 }}>
        <Alert severity="error">Invalid test identifier.</Alert>
      </Box>
    );
  }

  const fields = [
    { label: "File", value: test.file },
    { label: "Classname", value: test.classname },
    { label: "Name", value: test.name },
  ];

  return (
    <>
      <Head>
        <title>{test.name || "Test"} | PyTorch CI</title>
      </Head>
      <Box component="main" sx={{ maxWidth: 900, mx: "auto", p: 2 }}>
        <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
          Test
        </Typography>
        <Paper variant="outlined" sx={{ borderColor, p: 3 }}>
          <Stack spacing={3}>
            {fields.map(({ label, value }) => (
              <Box key={label}>
                <Typography
                  variant="overline"
                  component="div"
                  sx={{ color: labelColor }}
                >
                  {label}
                </Typography>
                <Typography
                  sx={{
                    color: theme.palette.text.primary,
                    overflowWrap: "anywhere",
                  }}
                >
                  {value || "Not reported"}
                </Typography>
              </Box>
            ))}
          </Stack>
        </Paper>
      </Box>
    </>
  );
}
