import ChevronRightIcon from "@mui/icons-material/ChevronRight";
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
  TableSortLabel,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import { durationDisplay } from "components/common/TimeUtils";
import { fetcherHandleError } from "lib/GeneralUtils";
import { encodeTestIdentity } from "lib/testIdentity";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { FormEvent, useEffect, useState } from "react";
import useSWR from "swr";

type DistinctTest = {
  name: string;
  classname: string;
  file: string | null;
  averageDurationSeconds: number | null;
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

type SortField = "file" | "classname" | "name" | "averageDuration" | "lastRun";
type SortOrder = "asc" | "desc";

const DEFAULT_SORT_FIELD: SortField = "averageDuration";
const DEFAULT_SORT_ORDER: SortOrder = "desc";
const TEST_COLUMNS: {
  field: SortField;
  label: string;
  width: string;
  align?: "left" | "right";
}[] = [
  { field: "file", label: "File", width: "25%" },
  { field: "classname", label: "Classname", width: "22%" },
  { field: "name", label: "Name", width: "26%" },
  {
    field: "averageDuration",
    label: "Avg duration",
    width: "12%",
    align: "right",
  },
  { field: "lastRun", label: "Last run", width: "15%" },
];

function isSortField(value: unknown): value is SortField {
  return TEST_COLUMNS.some(({ field }) => field === value);
}

function isSortOrder(value: unknown): value is SortOrder {
  return value === "asc" || value === "desc";
}

function defaultSortOrder(sort: SortField): SortOrder {
  return sort === "averageDuration" || sort === "lastRun" ? "desc" : "asc";
}

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

export default function TestsPage() {
  const router = useRouter();
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === "dark";
  const searchQuery =
    typeof router.query.q === "string" ? router.query.q.trim() : "";
  const cursor =
    typeof router.query.cursor === "string" ? router.query.cursor : undefined;
  const sortField = isSortField(router.query.sort)
    ? router.query.sort
    : DEFAULT_SORT_FIELD;
  const sortOrder = isSortOrder(router.query.order)
    ? router.query.order
    : defaultSortOrder(sortField);
  const [searchInput, setSearchInput] = useState("");
  const apiParams = new URLSearchParams();
  if (searchQuery) apiParams.set("q", searchQuery);
  if (cursor) apiParams.set("cursor", cursor);
  if (sortField !== DEFAULT_SORT_FIELD || sortOrder !== DEFAULT_SORT_ORDER) {
    apiParams.set("sort", sortField);
    apiParams.set("order", sortOrder);
  }
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
  const rowHoverColor = isDarkMode
    ? theme.palette.action.selected
    : theme.palette.action.hover;

  useEffect(() => {
    if (router.isReady) setSearchInput(searchQuery);
  }, [router.isReady, searchQuery]);

  const navigate = (
    nextSearch: string,
    nextCursor?: string,
    nextSort = sortField,
    nextOrder = sortOrder
  ) => {
    const isDefaultSort =
      nextSort === DEFAULT_SORT_FIELD && nextOrder === DEFAULT_SORT_ORDER;
    void router.push({
      pathname: router.pathname,
      query: {
        ...(nextSearch ? { q: nextSearch } : {}),
        ...(nextCursor ? { cursor: nextCursor } : {}),
        ...(!isDefaultSort ? { sort: nextSort, order: nextOrder } : {}),
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

  const handleSort = (field: SortField) => {
    const nextOrder =
      sortField === field
        ? sortOrder === "asc"
          ? "desc"
          : "asc"
        : defaultSortOrder(field);
    navigate(searchQuery, undefined, field, nextOrder);
  };

  const getTestHref = (test: DistinctTest) => {
    const id = encodeTestIdentity({
      file: test.file ?? "",
      classname: test.classname,
      name: test.name,
    });
    return `/test/${id}`;
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
                {TEST_COLUMNS.map(({ field, label, width, align }) => (
                  <TableCell
                    key={field}
                    align={align}
                    sortDirection={sortField === field ? sortOrder : false}
                    sx={{
                      width,
                      backgroundColor: headerBackgroundColor,
                      color: theme.palette.text.primary,
                      fontWeight: 600,
                    }}
                  >
                    <TableSortLabel
                      active={sortField === field}
                      direction={
                        sortField === field
                          ? sortOrder
                          : defaultSortOrder(field)
                      }
                      onClick={() => handleSort(field)}
                    >
                      {label}
                    </TableSortLabel>
                  </TableCell>
                ))}
                <TableCell
                  aria-label="Open test details"
                  sx={{
                    width: 48,
                    backgroundColor: headerBackgroundColor,
                  }}
                />
              </TableRow>
            </TableHead>
            <TableBody>
              {tests.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
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
                tests.map((test) => {
                  const href = getTestHref(test);
                  return (
                    <TableRow
                      hover
                      key={`${test.name}\u0000${test.classname}\u0000${
                        test.file ?? ""
                      }`}
                      onClick={() => void router.push(href)}
                      sx={{
                        cursor: "pointer",
                        transition: theme.transitions.create(
                          "background-color",
                          { duration: theme.transitions.duration.shortest }
                        ),
                        "&:hover, &:focus-within": {
                          backgroundColor: rowHoverColor,
                        },
                        "&:hover .test-name-link, &:focus-within .test-name-link":
                          {
                            textDecoration: "underline",
                          },
                        "& .row-chevron": {
                          color: theme.palette.text.secondary,
                          transition: theme.transitions.create(
                            ["color", "transform"],
                            { duration: theme.transitions.duration.shortest }
                          ),
                        },
                        "&:hover .row-chevron, &:focus-within .row-chevron": {
                          color: theme.palette.primary.main,
                          transform: "translateX(2px)",
                        },
                      }}
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
                        <Link
                          href={href}
                          className="test-name-link"
                          onClick={(event) => event.stopPropagation()}
                          style={{ color: theme.palette.primary.main }}
                        >
                          {test.name || "Not reported"}
                        </Link>
                      </TableCell>
                      <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                        {test.averageDurationSeconds === null ? (
                          <Typography
                            component="span"
                            color="text.secondary"
                            fontStyle="italic"
                          >
                            N/A
                          </Typography>
                        ) : (
                          durationDisplay(test.averageDurationSeconds)
                        )}
                      </TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>
                        {formatLastRun(test.lastRun)}
                      </TableCell>
                      <TableCell align="right" sx={{ width: 48, px: 1 }}>
                        <ChevronRightIcon
                          className="row-chevron"
                          fontSize="small"
                          aria-hidden="true"
                        />
                      </TableCell>
                    </TableRow>
                  );
                })
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
          <Typography variant="body2" color="text.secondary">
            Average duration is based on successful runs over the last 30 days.
            Select a column header to sort.
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
