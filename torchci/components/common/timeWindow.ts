// Turning a TimeRangePicker selection into stable ClickHouse query timestamps.

import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import isoWeek from "dayjs/plugin/isoWeek";
import utc from "dayjs/plugin/utc";

dayjs.extend(isoWeek);
dayjs.extend(utc);

// ClickHouse DateTime64(3) literal.
export const CLICKHOUSE_TIME_FORMAT = "YYYY-MM-DDTHH:mm:ss.SSS";

// Window width the pickers open on, in days.
export const DEFAULT_TIME_RANGE = 30;

// Windows wider than this disable auto-refresh so an idle long-range tab does
// not keep re-running a heavy query for data that is not moving.
export const LARGE_WINDOW_DAYS = 90;

// Snap a window START down to its granularity bucket before it becomes a query
// timestamp. TimeRangePicker re-derives "now" every 5 min, which would otherwise
// churn the SWR key every render; snapping keeps the key stable within a bucket
// (dedupes fetches and stops needless heavy re-runs).
export function snapToGranularity(
  time: dayjs.Dayjs,
  granularity: Granularity
): dayjs.Dayjs {
  const utc = time.utc();
  return granularity === "week"
    ? utc.startOf("isoWeek")
    : utc.startOf(granularity);
}

// Snap a window STOP up to the start of the NEXT bucket, so the (exclusive) upper
// bound includes the current in-progress bucket while staying fixed for that
// bucket's whole duration — same key-stability benefit, without hiding today.
export function snapStopToGranularity(
  time: dayjs.Dayjs,
  granularity: Granularity
): dayjs.Dayjs {
  return snapToGranularity(time, granularity).add(1, granularity);
}
