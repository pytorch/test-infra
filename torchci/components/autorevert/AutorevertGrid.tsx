import { Tooltip, Typography } from "@mui/material";
import { LocalTimeHuman } from "components/common/TimeUtils";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { AdvisorVerdict, buildVerdictsBySha } from "lib/advisorVerdictUtils";
import { useEffect, useMemo, useRef, useState } from "react";
import AutorevertCell from "./AutorevertCell";
import EventTimeline from "./EventTimeline";
import styles from "./autorevert.module.css";
import {
  AutorevertEventRow,
  AutorevertStateResponse,
  CellHighlight,
  ensureUtc,
  getHighlightsForOutcome,
  parseFilterTerms,
  SignalColumn,
  signalId,
  signalMatchesFilter,
} from "./types";

dayjs.extend(utc);

const OUTCOME_LABELS: Record<string, { label: string; cls: string }> = {
  revert: { label: "REV", cls: styles.outcomeRevert },
  restart: { label: "RST", cls: styles.outcomeRestart },
  ineligible: { label: "N/A", cls: styles.outcomeIneligible },
};

const INELIGIBLE_REASONS: Record<string, string> = {
  flaky:
    "This signal shows mixed results (pass and fail) on the same commit — autorevert cannot determine if this is a real regression.",
  fixed:
    "This signal is now passing on the most recent commit — the issue appears resolved.",
  no_successes:
    "No passing runs found in the lookback window — autorevert needs a known-good baseline to detect regressions.",
  no_partition: "Not enough commit history to determine a failure pattern.",
  infra_not_confirmed:
    "The failure may be an infrastructure issue — waiting for confirmation.",
  insufficient_failures:
    "Not enough failures to make a confident call — autorevert needs more data.",
  insufficient_successes: "Not enough passing runs to establish a baseline.",
  pending_gap:
    "Some commits between the failure and baseline have pending CI — waiting for results.",
  advisor_not_related:
    "AI advisor determined this failure is not related to the suspect commit.",
  advisor_garbage:
    "AI advisor flagged this signal as unreliable (infrastructure flake).",
};

function outcomeTooltip(
  col: SignalColumn,
  outcome: any | undefined
): React.ReactNode {
  const header = (
    <div style={{ fontWeight: 600, marginBottom: 4, fontSize: "0.9rem" }}>
      {signalId(col.workflow, col.key)}
    </div>
  );
  if (!outcome)
    return (
      <div style={{ fontSize: "0.85rem" }}>
        {header}
        <div style={{ opacity: 0.7 }}>No active autorevert pattern.</div>
      </div>
    );

  if (outcome.type === "AutorevertPattern") {
    const d = outcome.data;
    const newerCount = d.newer_failing_commits?.length || 0;
    return (
      <div style={{ fontSize: "0.85rem" }}>
        {header}
        <div style={{ color: "#f44336", fontWeight: 600, marginBottom: 4 }}>
          Decision: REVERT
        </div>
        <div>
          This signal started failing at commit{" "}
          <code>{d.suspected_commit?.slice(0, 7)}</code>
          {newerCount > 0 &&
            ` and continued failing on ${newerCount} newer commit${
              newerCount > 1 ? "s" : ""
            }`}
          . It was passing on baseline{" "}
          <code>{d.older_successful_commit?.slice(0, 7)}</code>.
        </div>
        {d.advisor_verdict && (
          <div style={{ marginTop: 4, opacity: 0.9 }}>
            AI advisor: <strong>{d.advisor_verdict.verdict}</strong> (
            {Math.round(d.advisor_verdict.confidence * 100)}% confidence)
          </div>
        )}
      </div>
    );
  }

  if (outcome.type === "RestartCommits") {
    const shas = outcome.data.commit_shas || [];
    return (
      <div style={{ fontSize: "0.85rem" }}>
        {header}
        <div style={{ color: "#1976d2", fontWeight: 600, marginBottom: 4 }}>
          Decision: RESTART
        </div>
        <div>
          Autorevert needs more data — restarting CI on {shas.length} commit
          {shas.length !== 1 ? "s" : ""} (
          {shas.map((s: string) => s.slice(0, 7)).join(", ")}) to confirm the
          failure pattern.
        </div>
      </div>
    );
  }

  if (outcome.type === "Ineligible") {
    const reason = outcome.data.reason || "";
    const explanation = INELIGIBLE_REASONS[reason] || outcome.data.message;
    return (
      <div style={{ fontSize: "0.85rem" }}>
        {header}
        <div style={{ color: "#757575", fontWeight: 600, marginBottom: 4 }}>
          Status: Not actionable ({reason.replace(/_/g, " ")})
        </div>
        <div>{explanation}</div>
      </div>
    );
  }

  return <div style={{ fontSize: "0.85rem" }}>{header}</div>;
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
  runTimestamps?: Array<{ ts: string; workflows: string[] }>;
  onTimestampChange?: (ts: string) => void;
  highlightSha?: string;
  hideTimeline?: boolean;
  revertFocus?: boolean;
}

export default function AutorevertGrid({
  state,
  signalFilter,
  advisorVerdicts,
  commitInfos,
  autorevertEvents,
  runTimestamps,
  onTimestampChange,
  highlightSha,
  hideTimeline,
  revertFocus,
}: AutorevertGridProps) {
  const repo = state.meta.repo;
  const [expandedColumn, setExpandedColumn] = useState<string | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const highlightRowRef = useRef<HTMLTableRowElement>(null);

  // Scroll highlighted commit into view on mount
  useEffect(() => {
    if (highlightSha && highlightRowRef.current) {
      highlightRowRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [highlightSha]);

  // Filter columns by signal filter text + revert focus
  const filteredColumns = useMemo(() => {
    let cols = state.columns;

    // Revert focus: only show signals with "revert" outcome or AI "revert" verdict
    if (revertFocus) {
      cols = cols.filter((col) => {
        const sigKey = signalId(col.workflow, col.key);
        const outcome = state.outcomes[sigKey];
        if (outcome?.type === "AutorevertPattern") return true;
        // Check for AI revert verdict in state-embedded results
        if (col.advisorResults) {
          for (const adv of Object.values(col.advisorResults)) {
            if (adv.verdict === "revert") return true;
          }
        }
        // Check CH-fetched verdicts
        if (advisorVerdicts) {
          for (const v of advisorVerdicts) {
            if (
              v.signalKey === col.key &&
              v.workflowName === col.workflow &&
              v.verdict === "revert"
            )
              return true;
          }
        }
        return false;
      });
    }

    if (signalFilter) {
      const terms = parseFilterTerms(signalFilter);
      if (terms.length > 0) {
        cols = cols.filter((col) =>
          signalMatchesFilter(signalId(col.workflow, col.key), terms)
        );
      }
    }

    return cols;
  }, [
    state.columns,
    state.outcomes,
    signalFilter,
    revertFocus,
    advisorVerdicts,
  ]);

  // Build highlights per column
  const highlightMaps = useMemo(() => {
    const maps: Map<string, Map<string, CellHighlight>> = new Map();
    for (const col of filteredColumns) {
      const sigKey = signalId(col.workflow, col.key);
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
      <div className={styles.timelineGridContainer}>
        {!hideTimeline && (
          <EventTimeline
            events={autorevertEvents || []}
            runTimestamps={runTimestamps}
            commits={state.commits}
            commitTimes={state.commitTimes}
            tableRef={tableRef}
            onTimestampSelect={onTimestampChange}
            currentSnapshotTs={state.ts}
          />
        )}
        <table className={styles.signalGrid} ref={tableRef}>
          <colgroup>
            <col className={styles.colTime} />
            <col className={styles.colSha} />
            {filteredColumns.map((col, i) => {
              const sigKey = signalId(col.workflow, col.key);
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
              {filteredColumns.map((col, i) => {
                const sigKey = signalId(col.workflow, col.key);
                const outcome = state.outcomes[sigKey];
                const tip = outcomeTooltip(col, outcome);
                const isExpanded = expandedColumn === sigKey;
                return (
                  <th
                    key={i}
                    className={`${styles.signalHeader} ${
                      isExpanded ? styles.colSignalExpanded : ""
                    }`}
                    onClick={() =>
                      setExpandedColumn(isExpanded ? null : sigKey)
                    }
                    style={{ cursor: "pointer" }}
                  >
                    <Tooltip title={tip} arrow placement="top">
                      <div className={styles.signalHeaderInner}>
                        {signalId(col.workflow, col.key)}
                      </div>
                    </Tooltip>
                  </th>
                );
              })}
            </tr>
            {/* Outcome badge row */}
            <tr>
              <th className={styles.colTime} />
              <th className={styles.colSha} />
              {filteredColumns.map((col, i) => {
                const { label, cls } =
                  OUTCOME_LABELS[col.outcome] || OUTCOME_LABELS.ineligible;
                const sigKey = signalId(col.workflow, col.key);
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
            {state.commits.map((sha) => {
              const time = state.commitTimes[sha];
              const shortSha = sha.slice(0, 7);
              const commitUrl = `https://github.com/${repo}/commit/${sha}`;
              const shaVerdicts = verdictsBySha.get(sha.trim()) || [];
              const ci = commitInfoMap.get(sha);

              // Parse PR number and title from commit message
              const prMatch = ci?.message?.match(/\(#(\d+)\)/);
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
                <tr
                  key={sha}
                  ref={sha === highlightSha ? highlightRowRef : undefined}
                  className={`${styles.commitRow} ${
                    sha === highlightSha ? styles.commitRowHighlighted : ""
                  }`}
                >
                  <td className={styles.colTime}>
                    {time && timeTooltip ? (
                      <Tooltip
                        title={timeTooltip}
                        arrow
                        disableInteractive={false}
                      >
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
                  {filteredColumns.map((col, i) => {
                    const sigKey = signalId(col.workflow, col.key);
                    const events = col.cells?.[sha] || [];
                    const highlight = highlightMaps.get(sigKey)?.get(sha);
                    const advisorResult = col.advisorResults?.[sha];
                    const wasDispatched = dispatchLookup.has(
                      `${sigKey}:${sha}`
                    );
                    const dispatchPending = wasDispatched && !advisorResult;

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
                        advisorWasDispatched={wasDispatched}
                        fullAdvisorVerdict={fullVerdict}
                        repo={repo}
                        isExpanded={expandedColumn === sigKey}
                        signalKey={col.key}
                        workflowName={col.workflow}
                        commitSha={sha}
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
    </div>
  );
}
