import { daySpan, timeAgoLabel } from "components/tests/TimeAgo";
import dayjs, { Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";
import { useEffect, useState } from "react";

dayjs.extend(utc);

// When a run started, in the viewer's time zone: marked Today when it is,
// by weekday within the last week, with the full date beyond that (daySpan,
// which the "Updated" caption's phrase decides by too).
export function lastRunLabel(timestamp: string, now: Dayjs = dayjs()): string {
  const time = dayjs.utc(timestamp).local();
  switch (daySpan(time, now)) {
    case "today":
      return `Today ${time.format("h:mm a")}`;
    case "week":
      return time.format("ddd h:mm a");
    case "earlier":
      return time.format("MMM D, YYYY h:mm a");
  }
}

// The label, with how long ago that was as its tooltip, "3 hours ago".
export default function LastRun({ timestamp }: { timestamp: string }) {
  // Filled in on the client only: the server does not know the viewer's
  // time zone, so it would render the wrong wall-clock time.
  const [display, setDisplay] = useState<{ label: string; ago: string }>();
  useEffect(() => {
    setDisplay({
      label: lastRunLabel(timestamp),
      ago: timeAgoLabel(timestamp),
    });
  }, [timestamp]);
  return <span title={display?.ago}>{display?.label}</span>;
}
