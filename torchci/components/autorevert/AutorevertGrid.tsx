import { Tooltip, Typography } from "@mui/material";
import { LocalTimeHuman } from "components/common/TimeUtils";
import {
  AdvisorVerdict,
  buildVerdictsBySha,
} from "lib/advisorVerdictUtils";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { useMemo, useState } from "react";
import AutorevertCell from "./AutorevertCell";
import styles from "./autorevert.module.css";
import {
  AutorevertEventRow,
  AutorevertStateResponse,
  CellHighlight,
  ensureUtc,
  EventCounts,
  getHighlightsForOutcome,
  parseChTimestamp,
  SignalColumn,
} from "./types";

dayjs.extend(utc);

const OUTCOME_LABELS: Record<string, { label: string; cls: string }> = {
  revert: { label: "REV", cls: styles.outcomeRevert },
  restart: { label: "RST", cls: styles.outcomeRestart },
  ineligible: { label: "N/A", cls: styles.outcomeIneligible },
};

function outcomeTooltip(
  col: SignalColumn,
  outcome: any | undefined
): string {
  const header = `${col.workflow}: ${col.key}`;
  if (!outcome) return header;
  if (outcome.type === "AutorevertPattern") {
    const d = outcome.data;
    const adv = d.advisor_verdict
      ? ` [AI: ${d.advisor_verdict.verdict} @${Math.round(d.advisor_verdict.confidence * 100)}%]`
      : "";
    return `${header}\n\nREVERT: suspect ${d.suspected_commit?.slice(0, 7)} vs baseline ${d.older_successful_commit?.slice(0, 7)}${adv}`;
  }
  if (outcome.type === "RestartCommits") {
    return `${header}\n\nRESTART: ${outcome.data.commit_shas?.map((s: string) => s.slice(0, 7)).join(", ")}`;
  }
  if (outcome.type === "Ineligible") {
    return `${header}\n\n${outcome.data.reason}: ${outcome.data.message}`;
  }
  return header;
}

/** Format UTC timestamp as local time for tooltips */
function formatLocalTime(isoTime: string): string {
  return dayjs(ensureUtc(isoTime)).local().format("YYYY-MM-DD h:mm A");
}

interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  time: string;
}

interface AutorevertGridProps {
  state: AutorevertStateResponse;
  signalFilter: string;
  advisorVerdicts?: AdvisorVerdict[];
  commitInfos?: CommitInfo[];
  autorevertEvents?: AutorevertEventRow[];
  onTimestampChange?: (ts: string) => void;
}

export default function AutorevertGrid({
  state,
  signalFilter,
  advisorVerdicts,
  commitInfos,
  autorevertEvents,
  onTimestampChange,
}: AutorevertGridProps) {
  const repo = state.meta.repo;
  const [expandedColumn, setExpandedColumn] = useState<string | null>(null);

  // Build event counts between consecutive commits
  // For each commit, count events that happened between this commit's time
  // and the next (newer) commit's time
  const eventCountsByCommit = useMemo(() => {
    const map = new Map<string, EventCounts>();
    if (!autorevertEvents || autorevertEvents.length === 0) return map;

    const commits = state.commits;
    const times = state.commitTimes;

    for (let i = 0; i < commits.length; i++) {
      const sha = commits[i];
      const commitTime = parseChTimestamp(times[sha]);
      // Next newer commit's time (or Infinity for the newest commit)
      const newerTime =
        i > 0 ? parseChTimestamp(times[commits[i - 1]]) : Infinity;

      const counts: EventCounts = { restart: 0, revert: 0, advisor: 0 };
      for (const ev of autorevertEvents) {
        const evTime = parseChTimestamp(ev.ts);
        if (evTime >= commitTime && evTime < newerTime) {
          if (ev.action in counts) {
            counts[ev.action as keyof EventCounts]++;
          }
        }
      }
      if (counts.restart > 0 || counts.revert > 0 || counts.advisor > 0) {
        map.set(sha, counts);
      }
    }
    return map;
  }, [autorevertEvents, state.commits, state.commitTimes]);

  // Filter columns by signal filter text
  const filteredColumns = useMemo(() => {
    if (!signalFilter) return state.columns;
    const lower = signalFilter.toLowerCase();
    return state.columns.filter(
      (col) =>
        col.key.toLowerCase().includes(lower) ||
        col.workflow.toLowerCase().includes(lower)
    );
  }, [state.columns, signalFilter]);

  // Build highlights per column
  const highlightMaps = useMemo(() => {
    const maps: Map<string, Map<string, CellHighlight>> = new Map();
    for (const col of filteredColumns) {
      const sigKey = `${col.workflow}:${col.key}`;
      const outcome = state.outcomes[sigKey];
      maps.set(sigKey, getHighlightsForOutcome(outcome));
    }
    return maps;
  }, [filteredColumns, state.outcomes]);

  // Build advisor dispatch lookup
  const dispatchLookup = useMemo(() => {
    const set = new Set<string>();
    for (const d of state.advisorDispatches || []) {
      set.add(`${d.signal_key}:${d.commit_sha}`);
    }
    return set;
  }, [state.advisorDispatches]);

  // Build advisor verdict lookup by sha
  const verdictsBySha = useMemo(
    () => buildVerdictsBySha(advisorVerdicts || []),
    [advisorVerdicts]
  );

  // Build commit info lookup
  const commitInfoMap = useMemo(() => {
    const map = new Map<string, CommitInfo>();
    for (const ci of commitInfos || []) {
      map.set(ci.sha, ci);
    }
    return map;
  }, [commitInfos]);

  if (filteredColumns.length === 0) {
    return (
      <Typography color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
        No signals match the current filters.
      </Typography>
    );
  }

  return (
    <div className={styles.gridWrapper}>
      <table className={styles.signalGrid}>
        <colgroup>
          <col className={styles.colTime} />
          <col className={styles.colSha} />
          <col className={styles.colEvents} />
          {filteredColumns.map((col, i) => {
            const sigKey = `${col.workflow}:${col.key}`;
            return (
              <col
                key={i}
                className={
                  expandedColumn === sigKey
                    ? styles.colSignalExpanded
                    : styles.colSignal
                }
              />
            );
          })}
        </colgroup>
        <thead>
          {/* Signal name headers (rotated) */}
          <tr>
            <th className={styles.colTime} />
            <th className={styles.colSha} />
            <th className={styles.signalHeader} />
            {filteredColumns.map((col, i) => {
              const sigKey = `${col.workflow}:${col.key}`;
              const outcome = state.outcomes[sigKey];
              const tip = outcomeTooltip(col, outcome);
              const isExpanded = expandedColumn === sigKey;
              return (
                <th
                  key={i}
                  className={`${styles.signalHeader} ${isExpanded ? styles.colSignalExpanded : ""}`}
                  onClick={() =>
                    setExpandedColumn(isExpanded ? null : sigKey)
                  }
                  style={{ cursor: "pointer" }}
                >
                  <Tooltip title={tip} arrow placement="top">
                    <div className={styles.signalHeaderInner}>{col.key}</div>
                  </Tooltip>
                </th>
              );
            })}
          </tr>
          {/* Outcome badge row */}
          <tr>
            <th className={styles.colTime} />
            <th className={styles.colSha} />
            <th className={styles.colEvents} />
            {filteredColumns.map((col, i) => {
              const { label, cls } =
                OUTCOME_LABELS[col.outcome] || OUTCOME_LABELS.ineligible;
              const sigKey = `${col.workflow}:${col.key}`;
              const outcome = state.outcomes[sigKey];
              const tip = outcomeTooltip(col, outcome);
              return (
                <td key={i} className={styles.colSignal}>
                  <Tooltip title={tip} arrow>
                    <span className={`${styles.outcomeBadge} ${cls}`}>
                      {label}
                    </span>
                  </Tooltip>
                </td>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {state.commits.map((sha, rowIdx) => {
            const time = state.commitTimes[sha];
            // Previous (newer) commit time for event tooltip
            const newerTime =
              rowIdx > 0
                ? state.commitTimes[state.commits[rowIdx - 1]]
                : undefined;
            const shortSha = sha.slice(0, 7);
            const commitUrl = `https://github.com/${repo}/commit/${sha}`;
            const shaVerdicts = verdictsBySha.get(sha.trim()) || [];
            const ci = commitInfoMap.get(sha);

            // Parse PR number and title from commit message
            const prMatch = ci?.message?.match(
              /\(#(\d+)\)/
            );
            const prNum = prMatch ? prMatch[1] : null;
            const title = ci?.message?.split("\n")[0] || "";

            const commitTooltip = ci ? (
              <div style={{ fontSize: "0.9rem", maxWidth: 400 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  {title}
                </div>
                <div style={{ opacity: 0.8, fontSize: "0.85rem" }}>
                  {ci.author} · {ci.time}
                </div>
                {prNum && (
                  <div style={{ marginTop: 6 }}>
                    <a
                      href={`https://github.com/${repo}/pull/${prNum}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "#1a73e8" }}
                    >
                      PR #{prNum}
                    </a>
                    {" · "}
                    <a
                      href={`https://hud.pytorch.org/${repo}/commit/${sha}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "#1a73e8" }}
                    >
                      HUD
                    </a>
                  </div>
                )}
              </div>
            ) : undefined;

            // Time tooltip with "go here" option
            const timeTooltip = time ? (
              <div style={{ fontSize: "0.9rem" }}>
                <div>{formatLocalTime(time)}</div>
                {onTimestampChange && (
                  <div
                    style={{
                      marginTop: 4,
                      color: "#1a73e8",
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onTimestampChange(time);
                    }}
                  >
                    Go here →
                  </div>
                )}
              </div>
            ) : undefined;

            return (
              <tr key={sha} className={styles.commitRow}>
                <td className={styles.colTime}>
                  {time && timeTooltip ? (
                    <Tooltip title={timeTooltip} arrow disableInteractive={false}>
                      <span style={{ cursor: "pointer" }}>
                        <LocalTimeHuman timestamp={ensureUtc(time)} />
                      </span>
                    </Tooltip>
                  ) : time ? (
                    <LocalTimeHuman timestamp={ensureUtc(time)} />
                  ) : (
                    ""
                  )}
                </td>
                <td className={styles.colSha}>
                  {commitTooltip ? (
                    <Tooltip title={commitTooltip} arrow>
                      <a
                        href={commitUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "var(--link-color, #1a73e8)" }}
                      >
                        {shortSha}
                      </a>
                    </Tooltip>
                  ) : (
                    <a
                      href={commitUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "var(--link-color, #1a73e8)" }}
                    >
                      {shortSha}
                    </a>
                  )}
                </td>
                <td className={styles.colEvents}>
                  {(() => {
                    const counts = eventCountsByCommit.get(sha);
                    if (!counts) return null;
                    const parts: JSX.Element[] = [];
                    if (counts.revert > 0)
                      parts.push(
                        <span key="r" className={styles.evtRevert}>
                          {counts.revert} RVT
                        </span>
                      );
                    if (counts.restart > 0)
                      parts.push(
                        <span key="s" className={styles.evtRestart}>
                          {counts.restart} RST
                        </span>
                      );
                    if (counts.advisor > 0)
                      parts.push(
                        <span key="a" className={styles.evtAdvisor}>
                          {counts.advisor} AI
                        </span>
                      );
                    if (parts.length === 0) return null;
                    return (
                      <Tooltip
                        title={
                          <span style={{ fontSize: "0.9rem" }}>
                            Events between {formatLocalTime(time)}{" "}
                            {newerTime
                              ? `and ${formatLocalTime(newerTime)}`
                              : "and now"}
                            {" — click to navigate"}
                          </span>
                        }
                        arrow
                      >
                        <span
                          className={styles.evtBadges}
                          style={{ cursor: onTimestampChange ? "pointer" : undefined }}
                          onClick={() => {
                            if (onTimestampChange && time) {
                              onTimestampChange(time);
                            }
                          }}
                        >
                          {parts}
                        </span>
                      </Tooltip>
                    );
                  })()}
                </td>
                {filteredColumns.map((col, i) => {
                  const sigKey = `${col.workflow}:${col.key}`;
                  const events = col.cells?.[sha] || [];
                  const highlight = highlightMaps.get(sigKey)?.get(sha);
                  const advisorResult = col.advisorResults?.[sha];
                  const dispatchPending =
                    dispatchLookup.has(`${sigKey}:${sha}`) && !advisorResult;

                  const fullVerdict = shaVerdicts.find(
                    (v) =>
                      v.signalKey === col.key &&
                      v.workflowName === col.workflow
                  );

                  return (
                    <AutorevertCell
                      key={i}
                      events={events}
                      highlight={highlight}
                      advisorResult={advisorResult}
                      advisorDispatchPending={dispatchPending}
                      fullAdvisorVerdict={fullVerdict}
                      repo={repo}
                      isExpanded={expandedColumn === sigKey}
                      onExpandColumn={() =>
                        setExpandedColumn(
                          expandedColumn === sigKey ? null : sigKey
                        )
                      }
                    />
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
