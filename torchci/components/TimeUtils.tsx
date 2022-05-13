import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { useEffect, useState } from "react";

dayjs.extend(utc);

export function LocalTimeHuman({ timestamp }: { timestamp: string }) {
  const [time, setTime] = useState<string | null>(null);
  // Why this weird dance with useEffect? Because we don't want to pre-render
  // this on the server-side as it would show results in the wrong timezone.
  // So we defer this computation to the client, where we have the right
  // timezone info.
  useEffect(() => {
    const time = dayjs(timestamp).local();
    if (dayjs().isSame(time, "day")) {
      setTime(time.format("h:mm A"));
    } else {
      setTime(time.format("ddd, MMM D"));
    }
  }, [timestamp]);
  return <span>{time}</span>;
}

// from: https://gist.github.com/g1eb/62d9a48164fe7336fdf4845e22ae3d2c
export function durationHuman(seconds: number) {
  var hours = Math.floor(seconds / 3600);
  var minutes = Math.floor((seconds - hours * 3600) / 60);
  var seconds = seconds - hours * 3600 - minutes * 60;
  if (!!hours) {
    if (!!minutes) {
      return `${hours}h ${minutes}m ${seconds}s`;
    } else {
      return `${hours}h ${seconds}s`;
    }
  }
  if (!!minutes) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

// Display duration in human-readable format, specialized for metrics.
// Given a number of seconds, convert it to the biggest possible unit of
// measurement and display with a scale of 1.
// e.g. 5400 -> "1.5h"
export function durationDisplay(seconds: number): string {
  if (seconds < 60) {
    return seconds + "s";
  }
  const minutes = seconds / 60.0;
  if (minutes < 60) {
    return minutes.toFixed(1) + "m";
  }
  const hours = minutes / 60.0;
  if (hours < 24) {
    return hours.toFixed(1) + "h";
  }
  const days = hours / 24.0;
  return days.toFixed(1) + "d";
}
