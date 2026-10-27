import dayjs, { Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";
import { useEffect, useState } from "react";

dayjs.extend(utc);

// Every ten seconds is often enough for a label that changes once a minute.
const TICK_MILLISECONDS = 10_000;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

// How long ago an instant was, in the coarsest whole unit.
export function timeAgoLabel(timestamp: string, now: Dayjs = dayjs()): string {
  const seconds = Math.max(0, now.diff(dayjs.utc(timestamp), "second"));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${plural(minutes, "min")} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${plural(hours, "hour")} ago`;
  }
  return `${plural(Math.floor(hours / 24), "day")} ago`;
}

// How far back an instant is by the viewer's calendar: today, within the
// week (yesterday through six days ago), or earlier. The labels that name a
// day, here and in the Last run cell, decide it the same way.
export type DaySpan = "today" | "week" | "earlier";
export function daySpan(time: Dayjs, now: Dayjs): DaySpan {
  if (now.isSame(time, "day")) {
    return "today";
  }
  return now.subtract(7, "day").isBefore(time, "day") ? "week" : "earlier";
}

// When an instant was, in the viewer's time zone, for the middle of a
// sentence: "today at 2:30 pm", the weekday within the last week, the full
// date beyond that.
export function whenPhrase(timestamp: string, now: Dayjs = dayjs()): string {
  const time = dayjs.utc(timestamp).local();
  const clock = time.format("h:mm a");
  switch (daySpan(time, now)) {
    case "today":
      return `today at ${clock}`;
    case "week":
      return `${time.format("dddd")} at ${clock}`;
    case "earlier":
      return `${time.format("MMM D, YYYY")} at ${clock}`;
  }
}

export interface TimeAgoDisplay {
  // How long ago: "5 mins ago".
  ago: string;
  // When: "today at 2:30 pm".
  when: string;
}

// How long ago an instant was and when it was, kept current by a timer.
// Undefined while there is no instant and until the first client render:
// the clock and zone are the viewer's, which the server does not know.
export function useTimeAgo(
  timestamp: string | null
): TimeAgoDisplay | undefined {
  const [display, setDisplay] = useState<TimeAgoDisplay>();
  useEffect(() => {
    if (timestamp === null) {
      setDisplay(undefined);
      return;
    }
    const update = () =>
      setDisplay({ ago: timeAgoLabel(timestamp), when: whenPhrase(timestamp) });
    update();
    const timer = window.setInterval(update, TICK_MILLISECONDS);
    return () => window.clearInterval(timer);
  }, [timestamp]);
  return display;
}
