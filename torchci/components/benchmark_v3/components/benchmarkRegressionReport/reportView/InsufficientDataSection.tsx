import {
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";
import { RenderRawContent } from "../../common/RawContentDialog";

type Order = "asc" | "desc";

const POINTS_LENGTH_KEY = "__points_length__";
const LATEST_TIMESTAMP_KEY = "__latest_timestamp__";

const cellSx = {
  padding: "2px 4px",
  fontSize: "0.75rem",
};

const headerCellSx = {
  ...cellSx,
  fontWeight: 600,
};

const getLatestTimestamp = (item: any): string => {
  const allPoints = [
    ...(item.all_baseline_points || []),
    ...(item.points || []),
  ];

  if (allPoints.length === 0) return "-";

  let latestTimestamp = "";
  for (const point of allPoints) {
    const ts = point.timestamp || "";
    if (ts > latestTimestamp) {
      latestTimestamp = ts;
    }
  }

  return latestTimestamp || "-";
};

export function InsufficientDataChartSection({
  metricItemList,
  title = "",
  includeKeys,
  orderedKeys = [],
}: {
  metricItemList: any[];
  title?: string;
  report_id: string;
  includeKeys?: string[];
  orderedKeys?: string[];
}) {
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [orderBy, setOrderBy] = useState<string>("");
  const [order, setOrder] = useState<Order>("asc");

  const allKeys = useMemo(() => {
    const keySet = new Set<string>();
    metricItemList.forEach((item) => {
      const groupInfo = item.group_info || {};
      Object.keys(groupInfo).forEach((key) => keySet.add(key));
    });
    let keys = Array.from(keySet);

    // Filter by includeKeys if provided
    if (includeKeys && includeKeys.length > 0) {
      keys = keys.filter((key) => includeKeys.includes(key));
    }

    // Sort: orderedKeys first (in order), then rest alphabetically
    const orderedSet = new Set(orderedKeys);
    const inOrder = orderedKeys.filter((key) => keys.includes(key));
    const rest = keys.filter((key) => !orderedSet.has(key)).sort();

    // Add special columns at the end
    return [...inOrder, ...rest, POINTS_LENGTH_KEY, LATEST_TIMESTAMP_KEY];
  }, [metricItemList, includeKeys, orderedKeys]);

  const handleChangePage = (_event: unknown, newPage: number) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  const handleRequestSort = (property: string) => {
    const isAsc = orderBy === property && order === "asc";
    setOrder(isAsc ? "desc" : "asc");
    setOrderBy(property);
  };

  const sortedItems = useMemo(() => {
    if (!orderBy) return metricItemList;

    return [...metricItemList].sort((a, b) => {
      let aValue, bValue;

      if (orderBy === POINTS_LENGTH_KEY) {
        aValue = a.points?.length ?? 0;
        bValue = b.points?.length ?? 0;
      } else if (orderBy === LATEST_TIMESTAMP_KEY) {
        aValue = getLatestTimestamp(a);
        bValue = getLatestTimestamp(b);
      } else {
        aValue = a.group_info?.[orderBy] ?? "";
        bValue = b.group_info?.[orderBy] ?? "";
      }

      if (aValue < bValue) return order === "asc" ? -1 : 1;
      if (aValue > bValue) return order === "asc" ? 1 : -1;
      return 0;
    });
  }, [metricItemList, orderBy, order]);

  const paginatedItems = useMemo(() => {
    const start = page * rowsPerPage;
    return sortedItems.slice(start, start + rowsPerPage);
  }, [sortedItems, page, rowsPerPage]);

  const getCellValue = (item: any, key: string) => {
    if (key === POINTS_LENGTH_KEY) {
      return item.points?.length ?? 0;
    }
    if (key === LATEST_TIMESTAMP_KEY) {
      return getLatestTimestamp(item);
    }
    return item.group_info?.[key] ?? "-";
  };

  const getHeaderLabel = (key: string) => {
    if (key === POINTS_LENGTH_KEY) {
      return "# new points";
    }
    if (key === LATEST_TIMESTAMP_KEY) {
      return "Latest ";
    }
    return key.startsWith("extra_key.") ? key.slice(10) : key;
  };

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 1.5 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Metrics with insufficient data to determine regression status. At least
        2 data points are required for analysis. The &quot;Latest&quot; column
        shows the most recent timestamp.
      </Typography>
      <RenderRawContent data={sortedItems} />
      <TableContainer sx={{ maxHeight: 500 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              {allKeys.map((key: string) => (
                <TableCell
                  key={key}
                  sortDirection={orderBy === key ? order : false}
                  sx={headerCellSx}
                >
                  <TableSortLabel
                    active={orderBy === key}
                    direction={orderBy === key ? order : "asc"}
                    onClick={() => handleRequestSort(key)}
                  >
                    {getHeaderLabel(key)}
                  </TableSortLabel>
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {paginatedItems.map((item, idx) => {
              return (
                <TableRow key={idx}>
                  {allKeys.map((key: string) => (
                    <TableCell key={key} sx={cellSx}>
                      {getCellValue(item, key)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <TablePagination
        rowsPerPageOptions={[10, 25, 50, 100]}
        component="div"
        count={metricItemList.length}
        rowsPerPage={rowsPerPage}
        page={page}
        onPageChange={handleChangePage}
        onRowsPerPageChange={handleChangeRowsPerPage}
      />
    </Box>
  );
}
