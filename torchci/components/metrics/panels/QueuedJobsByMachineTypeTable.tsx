import { Link, Tooltip, Typography } from "@mui/material";
import { GridColDef } from "@mui/x-data-grid";
import { durationDisplay } from "components/common/TimeUtils";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import { fetcher } from "lib/GeneralUtils";
import { useMemo, useState } from "react";
import useSWR from "swr";

// "Queued Jobs by Machine Type", with jobs whose workflow run looks abandoned
// by GitHub left out by default.
//
// Those jobs are real rows in ClickHouse that in all likelihood no runner will
// pick up, and they can sit in this table for a week showing multi-day queue
// times for a pool that is actually healthy. Leaving them out is the default,
// because the number a reader wants is "how long is the wait right now". A
// machine type with nothing left once they are gone has no queue to report, so
// its row is dropped rather than shown as a zero.
//
// It is only a guess — see clickhouse_queries/queued_jobs_by_label/query.sql
// for what the classifier can and cannot establish — so it never acts
// unannounced. The panel title is the whole of that promise now that there is
// no per-row marker: while anything is being left out it says how many jobs,
// how old, and NAMES every machine type that left the table with them. One
// click puts all of it back.
//
// The classifier's own liveness condition is what usually keeps a real outage
// on screen: a job is only suspect when some other job asking for exactly its
// labels reached a runner in the last hour, so a pool serving nothing keeps
// every job counted. It is not a guarantee — labels are not the whole of what
// a job is scheduled against, and a pool that fails outright can stay inside
// that one-hour window — which is why the title names what it hid.
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

  // A machine type with no jobs left has no queue to report, so it leaves the
  // table until the toggle brings it back. `data` rather than `rows` so
  // `undefined` still reaches TablePanelWithData as the loading state.
  const shownRows = leaveOutStuck
    ? rows.filter((row) => shownCount(row) > 0)
    : data;
  // Named, not counted. A row is the only per-machine-type signal this panel
  // has, so an oncall reading a title that says two pools vanished still has to
  // guess which — and the one they are looking for is the one most likely to be
  // missing.
  const hiddenTypes: string[] = leaveOutStuck
    ? rows.filter((row) => shownCount(row) === 0).map((row) => row.machine_type)
    : [];
  const hiddenList =
    hiddenTypes.length <= 3
      ? hiddenTypes.join(", ")
      : `${hiddenTypes.slice(0, 3).join(", ")} and ${
          hiddenTypes.length - 3
        } more`;

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
        valueGetter: (_value: any, row: any) => shownQueueS(row),
        valueFormatter: (params: number) => durationDisplay(params),
        cellClassName: (params) => {
          const queueTimeHours = params.value / 3600;
          if (queueTimeHours >= 4) return "queue-time-red";
          if (queueTimeHours >= 1) return "queue-time-yellow";
          return "";
        },
      },
      { field: "machine_type", headerName: "Machine Type", flex: 4 },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leaveOutStuck]
  );

  // The whole of what tells a reader something is missing, so it names both
  // things that can be: the jobs left out of every figure, and the machine
  // types that lost their last job and left the table with it.
  const title =
    stuckJobs === 0 ? (
      "Queued Jobs by Machine Type"
    ) : (
      <span>
        Queued Jobs by Machine Type{" "}
        <Typography component="span" fontSize="13px" fontWeight="400">
          — {stuckJobs} job{stuckJobs === 1 ? "" : "s"} look stuck (oldest{" "}
          {durationDisplay(oldestStuckS)}),{" "}
          {leaveOutStuck ? "left out" : "counted below"}
          {leaveOutStuck && hiddenTypes.length > 0
            ? `; ${hiddenList} hidden`
            : ""}
          .{" "}
          <Tooltip
            title={
              "A queued job is called stuck when its workflow run is over 6h " +
              "old and has never been updated, the job itself never reached a " +
              "runner, and some other job asking for exactly the same labels " +
              "did reach one in the last hour. Labels are not the whole of " +
              "what a job is scheduled against, so this can be wrong in " +
              "either direction."
            }
          >
            <Link
              component="button"
              underline="always"
              fontSize="13px"
              onClick={() => setCountSuspectedStuck(!countSuspectedStuck)}
            >
              {leaveOutStuck ? "Show them" : "Leave them out"}
            </Link>
          </Tooltip>
        </Typography>
      </span>
    );

  return (
    <TablePanelWithData
      title={title}
      data={shownRows}
      columns={columns}
      dataGridProps={{
        getRowId: (el: any) => el.machine_type,
        initialState: {
          sorting: {
            sortModel: [{ field: "avg_queue_s", sort: "desc" }],
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
