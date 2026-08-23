import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import { fetcherHandleError } from "lib/GeneralUtils";
import Head from "next/head";
import { useRouter } from "next/router";
import { FormEvent, useEffect, useState } from "react";
import useSWR from "swr";

type DistinctTest = {
  name: string;
  classname: string;
  file: string | null;
  lastRun: string;
};

type DistinctTestsResponse = {
  tests: DistinctTest[];
  pageInfo: {
    hasPreviousPage: boolean;
    hasNextPage: boolean;
    previousCursor: string | null;
    nextCursor: string | null;
  };
};

const PAGE_SIZE = 100;
const lastRunFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

function formatLastRun(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : lastRunFormatter.format(date);
}

export default function TestPage() {
  const router = useRouter();
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === "dark";
  const searchQuery =
    typeof router.query.q === "string" ? router.query.q.trim() : "";
  const cursor =
    typeof router.query.cursor === "string" ? router.query.cursor : undefined;
  const [searchInput, setSearchInput] = useState("");
  const apiParams = new URLSearchParams();
  if (searchQuery) apiParams.set("q", searchQuery);
  if (cursor) apiParams.set("cursor", cursor);
  const apiQuery = apiParams.toString();
  const apiUrl = router.isReady
    ? `/api/tests/distinct${apiQuery ? `?${apiQuery}` : ""}`
    : null;
  const { data, error, isLoading, isValidating, mutate } =
    useSWR<DistinctTestsResponse>(apiUrl, fetcherHandleError, {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    });

  const tableBorderColor = isDarkMode
    ? theme.palette.grey[800]
    : theme.palette.grey[300];
  const headerBackgroundColor = isDarkMode
    ? theme.palette.grey[900]
    : theme.palette.grey[100];
  const emptyBackgroundColor = isDarkMode
    ? theme.palette.grey[900]
    : theme.palette.grey[50];

  useEffect(() => {
    if (router.isReady) setSearchInput(searchQuery);
  }, [router.isReady, searchQuery]);

  const navigate = (nextSearch: string, nextCursor?: string) => {
    void router.push({
      pathname: router.pathname,
      query: {
        ...(nextSearch ? { q: nextSearch } : {}),
        ...(nextCursor ? { cursor: nextCursor } : {}),
      },
    });
  };

  const navigateToCursor = (nextCursor: string | null) => {
    navigate(searchQuery, nextCursor ?? undefined);
  };

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextSearch = searchInput.trim();
    setSearchInput(nextSearch);
    navigate(nextSearch);
  };

  const clearSearch = () => {
    setSearchInput("");
    navigate("");
  };

  const content = (() => {
    if (!router.isReady || isLoading) {
      return (
        <Stack
          alignItems="center"
          justifyContent="center"
          spacing={2}
          sx={{ minHeight: 320 }}
        >
          <CircularProgress />
          <Typography color="text.secondary">Loading tests…</Typography>
        </Stack>
      );
    }

    if (error) {
      return (
        <Alert
          severity="error"
          action={
            <Stack direction="row" spacing={1}>
              {cursor && (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => navigateToCursor(null)}
                >
                  Start over
                </Button>
              )}
              <Button
                color="inherit"
                size="small"
                onClick={() => void mutate()}
              >
                Retry
              </Button>
            </Stack>
          }
        >
          Unable to load tests. Please try again.
        </Alert>
      );
    }

    const tests = data?.tests ?? [];
    const pageInfo = data?.pageInfo;

    return (
      <Stack spacing={2}>
        <TableContainer
          component={Paper}
          variant="outlined"
          sx={{ borderColor: tableBorderColor }}
        >
          <Table size="small" aria-label="PyTorch tests">
            <TableHead>
              <TableRow>
                {[
                  { label: "File", width: "30%" },
                  { label: "Classname", width: "25%" },
                  { label: "Name", width: "30%" },
                  { label: "Last run", width: "15%" },
                ].map(({ label, width }) => (
                  <TableCell
                    key={label}
                    sx={{
                      width,
                      backgroundColor: headerBackgroundColor,
                      color: theme.palette.text.primary,
                      fontWeight: 600,
                    }}
                  >
                    {label}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {tests.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    align="center"
                    sx={{ py: 8, backgroundColor: emptyBackgroundColor }}
                  >
                    <Typography color="text.secondary">
                      {searchQuery
                        ? "No tests matched your search."
                        : "No tests were found."}
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                tests.map((test, index) => (
                  <TableRow
                    hover
                    key={`${test.name}\u0000${test.classname}\u0000${
                      test.file ?? ""
                    }\u0000${index}`}
                  >
                    <TableCell sx={{ overflowWrap: "anywhere" }}>
                      {test.file ? (
                        test.file
                      ) : (
                        <Typography
                          component="span"
                          color="text.secondary"
                          fontStyle="italic"
                        >
                          Not reported
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell sx={{ overflowWrap: "anywhere" }}>
                      {test.classname}
                    </TableCell>
                    <TableCell sx={{ overflowWrap: "anywhere" }}>
                      {test.name}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: "nowrap" }}>
                      {formatLastRun(test.lastRun)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>

        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          spacing={2}
        >
          <Typography variant="body2" color="text.secondary">
            Showing up to {PAGE_SIZE} tests
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button
              variant="outlined"
              disabled={
                isValidating ||
                !pageInfo?.hasPreviousPage ||
                !pageInfo.previousCursor
              }
              onClick={() => navigateToCursor(pageInfo?.previousCursor ?? null)}
            >
              Previous
            </Button>
            <Button
              variant="contained"
              disabled={
                isValidating || !pageInfo?.hasNextPage || !pageInfo.nextCursor
              }
              onClick={() => navigateToCursor(pageInfo?.nextCursor ?? null)}
            >
              Next
            </Button>
          </Stack>
        </Stack>
      </Stack>
    );
  })();

  return (
    <>
      <Head>
        <title>Tests | PyTorch CI</title>
      </Head>
      <Box component="main" sx={{ maxWidth: 1400, mx: "auto", p: 2 }}>
        <Stack spacing={0.5} sx={{ mb: 3 }}>
          <Typography variant="h4" component="h1">
            Tests
          </Typography>
        </Stack>
        <Box
          component="form"
          onSubmit={handleSearch}
          sx={{
            display: "flex",
            alignItems: { xs: "stretch", sm: "center" },
            flexDirection: { xs: "column", sm: "row" },
            gap: 1,
            mb: 3,
          }}
        >
          <TextField
            fullWidth
            size="small"
            label="Search tests"
            placeholder="File, classname, or name"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            inputProps={{ maxLength: 200 }}
          />
          <Button type="submit" variant="contained" disabled={isValidating}>
            Search
          </Button>
          {(searchInput || searchQuery) && (
            <Button
              type="button"
              variant="outlined"
              disabled={isValidating}
              onClick={clearSearch}
            >
              Clear
            </Button>
          )}
        </Box>
        {content}
      </Box>
    </>
  );
}
