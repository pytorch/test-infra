// Fold `ci: disable-autorevert` label add/remove events on pytorch/pytorch
// issues into per-issue active intervals. The autorevert lambda only honors
// the label on OPEN issues, so an issue close acts as an implicit
// `unlabeled` event if no explicit one preceded it.

export interface KillswitchLabelEvent {
  event_time: string;
  action: "labeled" | "unlabeled" | string;
  issue_number: number;
  issue_closed_at: string;
}

export interface KillswitchWindow {
  issue_number: number;
  on: string;
  off: string | null;
}

export function foldKillswitchWindows(
  events: KillswitchLabelEvent[]
): KillswitchWindow[] {
  const byIssue = new Map<number, KillswitchLabelEvent[]>();
  for (const e of events) {
    if (!byIssue.has(e.issue_number)) byIssue.set(e.issue_number, []);
    byIssue.get(e.issue_number)!.push(e);
  }
  const windows: KillswitchWindow[] = [];
  for (const [issueNumber, evs] of byIssue.entries()) {
    evs.sort((a, b) => a.event_time.localeCompare(b.event_time));
    let onTs: string | null = null;
    for (const e of evs) {
      if (e.action === "labeled" && onTs === null) {
        onTs = e.event_time;
      } else if (e.action === "unlabeled" && onTs !== null) {
        windows.push({
          issue_number: issueNumber,
          on: onTs,
          off: e.event_time,
        });
        onTs = null;
      }
    }
    if (onTs !== null) {
      const closedAt = evs[0].issue_closed_at;
      windows.push({
        issue_number: issueNumber,
        on: onTs,
        off: closedAt && closedAt !== "" ? closedAt : null,
      });
    }
  }
  windows.sort((a, b) => a.on.localeCompare(b.on));
  return windows;
}

export function killswitchWindowAt(
  windows: KillswitchWindow[],
  t: string
): KillswitchWindow | null {
  const ts = new Date(t).getTime();
  for (const w of windows) {
    const on = new Date(w.on).getTime();
    const off = w.off === null ? Infinity : new Date(w.off).getTime();
    if (ts >= on && ts <= off) return w;
  }
  return null;
}
