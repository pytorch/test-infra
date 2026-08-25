import { Link, Typography } from "@mui/material";
import { GridColDef } from "@mui/x-data-grid";
import { durationDisplay } from "components/common/TimeUtils";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import { fetcher } from "lib/GeneralUtils";
import { useMemo, useState } from "react";
import useSWR from "swr";

// "Queued Jobs by Machine Type", with the option to leave out jobs whose
// workflow run looks abandoned by GitHub.
//
// Those jobs are real rows in ClickHouse that no runner will ever pick up, and
// they can sit in this table for a week showing multi-day queue times for a
// pool that is actually healthy. Leaving them out is the default, because the
// number a reader wants is "how long is the wait right now".
//
// It is only a guess — see clickhouse_queries/queued_jobs_by_label/query.sql
// for what the classifier can and cannot establish — so two rules constrain it.
//
// It never acts unannounced. While any job is being left out, the panel title
// says how many and how old, one click puts them back, and every machine type
// stays in the table either way.
//
// And it never decides the reading order. The DEFAULT sort is the hidden
// sort_queue_s below, which is always the raw queue time, so while that sort is
// active — which is every unattended view of this page — flipping the toggle
// cannot move a machine type down the table or off the bottom of it. That is
// how a mistaken guess would hide a real outage from someone scanning the top.
// A reader who clicks a header is then sorting on what they can actually see,
// and rows do move when they toggle after that: they changed the definition of
// the figure they sorted by, and holding the old order would be the misleading
// choice.
export default function QueuedJobsByMachineTypeTable({
  onMachineTypeClick,
}: {
  onMachineTypeClick: (_machineType: string) => void;
}) {
  const [countSuspectedStuck, setCountSuspectedStuck] = useState(false);

  const url = `/api/clickhouse/queued_jobs_by_label?parameters=${encodeURIComponent(
    JSON.stringify({})
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 5 * 60 * 1000, // refresh every 5 minutes
  });

  const rows: any[] = data ?? [];

  // A payload without the classifier's columns — a mixed-version deploy, or a
  // response cached from before they existed — must not be filtered against
  // fields that are not there, which would put NaN in every cell. Note that
  // Number(null), Number("") and Number(false) are all a finite 0, so a
  // presence test has to reject those shapes rather than coerce them. On any
  // doubt, fall back to the raw figures, which have always been present, and
  // offer no toggle at all.
  const isCount = (value: any) =>
    (typeof value === "number" ||
      (typeof value === "string" && value.trim() !== "")) &&
    // Every field checked with this is a COUNTIf or a DATE_DIFF in seconds, so
    // a negative or fractional one is not a number this panel can render —
    // "-1 jobs look stuck" is worse than falling back to the raw figures.
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= 0;
  const canLeaveOutStuck =
    rows.length > 0 &&
    rows.every(
      (row) =>
        row != null &&
        typeof row === "object" &&
        ["count", "live_count", "live_max_queue_s", "stale_count"].every(
          (field) => isCount(row[field])
        ) &&
        // Only required where it will actually be read, but required there:
        // the promise this panel makes is to say how many jobs it left out AND
        // how old, and a missing age would quietly render that as zero.
        (Number(row.stale_count) === 0 || isCount(row.oldest_stale_s)) &&
        // The query defines these as COUNT(*), COUNTIf(NOT is_stale) and
        // COUNTIf(is_stale) over one population, so this always holds. If it
        // does not, the payload is not the one this panel was written for.
        Number(row.live_count) + Number(row.stale_count) === Number(row.count)
    );
  const leaveOutStuck = canLeaveOutStuck && !countSuspectedStuck;

  const stuckJobs = canLeaveOutStuck
    ? rows.reduce((n, row) => n + Number(row.stale_count), 0)
    : 0;
  // Only rows that actually contribute a suspected job. A row with none of them
  // is the one whose oldest_stale_s the guard above does not require, so
  // reading it here would let an unvalidated value set the age in the title.
  const oldestStuckS = canLeaveOutStuck
    ? rows.reduce(
        (oldest, row) =>
          Number(row.stale_count) > 0
            ? Math.max(oldest, Number(row.oldest_stale_s))
            : oldest,
        0
      )
    : 0;

  // What a row's two headline figures say — and, once a reader sorts or filters
  // on them, what those act on too.
  const shownCount = (row: any) =>
    leaveOutStuck ? Number(row.live_count) : Number(row.count);
  const shownQueueS = (row: any) =>
    leaveOutStuck ? Number(row.live_max_queue_s) : Number(row.avg_queue_s);

  const columns: GridColDef[] = useMemo(
    () => [
      {
        field: "count",
        headerName: "Count",
        flex: 1,
        type: "number",
        valueGetter: (_value: any, row: any) => shownCount(row),
      },
      {
        field: "avg_queue_s",
        headerName: "Queue time",
        flex: 1,
        type: "number",
        // A machine type with nothing left once the suspected jobs are removed
        // has no queue time, which is not the same as a queue time of zero.
        // null rather than 0 keeps that distinction in the value itself, so
        // sorting, "is empty" and the absence of a colour all agree with the
        // dash on screen.
        valueGetter: (_value: any, row: any) =>
          shownCount(row) === 0 ? null : shownQueueS(row),
        valueFormatter: (params: number | null) =>
          params == null ? "—" : durationDisplay(params),
        cellClassName: (params) => {
          if (params.value == null) return "";
          const queueTimeHours = params.value / 3600;
          if (queueTimeHours >= 4) return "queue-time-red";
          if (queueTimeHours >= 1) return "queue-time-yellow";
          return "";
        },
      },
      {
        field: "stale_count",
        headerName: "Suspected stuck",
        description:
          "How many of this machine type's queued jobs match the " +
          "abandoned-run heuristic: the workflow run is over 6h old and its " +
          "recorded update time still equals its creation time, the job is " +
          "still queued with no runner and no steps recorded, and some job " +
          "created in the last hour with exactly the same labels did get a " +
          "runner. Labels are not the whole of what a job is scheduled " +
          "against, so this can be wrong in either direction. Use the link in " +
          "the title to count these jobs again.",
        flex: 1,
        type: "number",
        // COUNTIf is a UInt64 and should arrive as a JSON number, but that was
        // not verifiable end-to-end; a string would sort "10" below "2".
        valueGetter: (value: any) => Number(value),
        // Descending first: an ascending click would push every affected row
        // below the blanks, the one ordering a reader would not expect from a
        // column about exceptions.
        sortingOrder: ["desc", "asc", null],
        // Blank rather than "0" so the column reads as an exception marker.
        // NaN, from a payload without the column, is blank for the same reason.
        valueFormatter: (params: number, row: any) =>
          params > 0
            ? `${params} · ${durationDisplay(Number(row.oldest_stale_s))}`
            : "",
      },
      { field: "machine_type", headerName: "Machine Type", flex: 3 },
      // Not displayed. Carries the raw queue time so the DEFAULT ordering is
      // the same in both modes; see the note at the top of the file. Hiding a
      // column does not by itself keep it out of the filter panel, the column
      // chooser or an all-columns export, and a filter on a value nobody can
      // see is worse than no filter — hence the opt-outs. `sortable: false`
      // only disables sorting by header interaction; the initial sort model
      // below still orders by this column.
      {
        field: "sort_queue_s",
        sortable: false,
        filterable: false,
        hideable: false,
        disableExport: true,
        disableColumnMenu: true,
        valueGetter: (_value: any, row: any) => Number(row.avg_queue_s),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leaveOutStuck]
  );

  const title =
    stuckJobs === 0 ? (
      "Queued Jobs by Machine Type"
    ) : (
      <span>
        Queued Jobs by Machine Type{" "}
        <Typography component="span" fontSize="13px" fontWeight="400">
          — {stuckJobs} job{stuckJobs === 1 ? "" : "s"} look stuck (oldest{" "}
          {durationDisplay(oldestStuckS)}),{" "}
          {leaveOutStuck ? "not counted below" : "counted below"}.{" "}
          <Link
            component="button"
            underline="always"
            fontSize="13px"
            onClick={() => setCountSuspectedStuck(!countSuspectedStuck)}
          >
            {leaveOutStuck ? "Count them" : "Leave them out"}
          </Link>
        </Typography>
      </span>
    );

  return (
    <TablePanelWithData
      title={title}
      data={data}
      columns={columns}
      dataGridProps={{
        getRowId: (el: any) => el.machine_type,
        // Both under initialState. As a controlled `columnVisibilityModel` prop
        // with no change handler, this would freeze visibility for EVERY column
        // and leave the column chooser unable to hide anything.
        initialState: {
          columns: { columnVisibilityModel: { sort_queue_s: false } },
          sorting: {
            sortModel: [{ field: "sort_queue_s", sort: "desc" }],
          },
        },
        onRowClick: (params: any) => {
          onMachineTypeClick(params.row.machine_type);
        },
        sx: {
          "& .queue-time-yellow": {
            backgroundColor: "#B8860B", // Dark goldenrod
            color: "white",
          },
          "& .queue-time-red": {
            backgroundColor: "#B22222", // Fire brick red
            color: "white",
          },
          "& .MuiDataGrid-row": {
            cursor: "pointer",
          },
        },
      }}
    />
  );
}
