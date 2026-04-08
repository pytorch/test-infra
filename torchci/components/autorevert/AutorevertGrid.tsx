import { Tooltip, Typography } from "@mui/material";
import {
  AdvisorVerdict,
  buildVerdictsBySha,
} from "lib/advisorVerdictUtils";
import { useMemo } from "react";
import AutorevertCell from "./AutorevertCell";
import styles from "./autorevert.module.css";
import {
  AdvisorDispatch,
  AutorevertStateResponse,
  CellHighlight,
  getHighlightsForOutcome,
  SignalColumn,
} from "./types";

const OUTCOME_LABELS: Record<string, { label: string; cls: string }> = {
  revert: { label: "REV", cls: styles.outcomeRevert },
  restart: { label: "RST", cls: styles.outcomeRestart },
  ineligible: { label: "N/A", cls: styles.outcomeIneligible },
};

function outcomeTooltip(
  col: SignalColumn,
  outcome: any | undefined
): string {
  if (!outcome) return `${col.workflow}: ${col.key}`;
  if (outcome.type === "AutorevertPattern") {
    const d = outcome.data;
    const adv = d.advisor_verdict
      ? ` [AI: ${d.advisor_verdict.verdict} @${Math.round(d.advisor_verdict.confidence * 100)}%]`
      : "";
    return `REVERT: suspect ${d.suspected_commit?.slice(0, 7)} vs baseline ${d.older_successful_commit?.slice(0, 7)}${adv}`;
  }
  if (outcome.type === "RestartCommits") {
    return `RESTART: ${outcome.data.commit_shas?.map((s: string) => s.slice(0, 7)).join(", ")}`;
  }
  if (outcome.type === "Ineligible") {
    return `${outcome.data.reason}: ${outcome.data.message}`;
  }
  return col.key;
}

function formatCommitTime(isoTime: string): string {
  const d = new Date(isoTime);
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
}

interface AutorevertGridProps {
  state: AutorevertStateResponse;
  signalFilter: string;
  advisorVerdicts?: AdvisorVerdict[];
}

export default function AutorevertGrid({
  state,
  signalFilter,
  advisorVerdicts,
}: AutorevertGridProps) {
  const repo = state.meta.repo;

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

  // Build advisor dispatch lookup: (signal_key, commit_sha) → true
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
          {filteredColumns.map((_, i) => (
            <col key={i} className={styles.colSignal} />
          ))}
        </colgroup>
        <thead>
          {/* Signal name headers (rotated) */}
          <tr>
            <th className={styles.colTime} />
            <th className={styles.colSha} />
            {filteredColumns.map((col, i) => {
              const sigKey = `${col.workflow}:${col.key}`;
              const outcome = state.outcomes[sigKey];
              const tip = outcomeTooltip(col, outcome);
              return (
                <th key={i} className={styles.signalHeader}>
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
          {state.commits.map((sha) => {
            const time = state.commitTimes[sha];
            const shortSha = sha.slice(0, 7);
            const commitUrl = `https://github.com/${repo}/commit/${sha}`;
            const shaVerdicts = verdictsBySha.get(sha.trim()) || [];

            return (
              <tr key={sha} className={styles.commitRow}>
                <td className={styles.colTime}>
                  {time ? formatCommitTime(time) : ""}
                </td>
                <td className={styles.colSha}>
                  <a
                    href={commitUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "var(--link-color, #1a73e8)" }}
                  >
                    {shortSha}
                  </a>
                </td>
                {filteredColumns.map((col, i) => {
                  const sigKey = `${col.workflow}:${col.key}`;
                  const events = col.cells?.[sha] || [];
                  const highlight = highlightMaps.get(sigKey)?.get(sha);
                  const advisorResult = col.advisorResults?.[sha];
                  const dispatchPending =
                    dispatchLookup.has(`${sigKey}:${sha}`) && !advisorResult;

                  // Find full verdict from dedicated CH table
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
