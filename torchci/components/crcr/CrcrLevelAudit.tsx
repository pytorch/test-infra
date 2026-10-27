import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Chip,
  Link,
  ListItemButton,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { LocalTimeHuman } from "components/common/TimeUtils";
import {
  auditDisplayTime,
  firstAuditValue,
  isSafeHttpUrl,
  LevelAuditDecision,
  parseCriteriaSnapshot,
  useLevelAudit,
} from "lib/crcr/levelAudit";
import { LevelHistoryEvent, useLevelHistory } from "lib/crcr/levelHistory";
import { ReactNode, useState } from "react";

function kindColor(kind: string) {
  if (kind === "promotion") return "success" as const;
  if (kind === "demotion") return "error" as const;
  return "info" as const;
}

function displayKind(kind: string) {
  if (kind === "initial") return "Initial onboarding";
  return kind ? kind[0].toUpperCase() + kind.slice(1) : "Unknown";
}

function displaySource(source: string) {
  if (source === "automation") return "Automated";
  if (source === "maintainer") return "Manual";
  if (source === "onboarding") return "Onboarding";
  return source ? source[0].toUpperCase() + source.slice(1) : "Unknown";
}

function displayState(state: string) {
  return state ? state[0].toUpperCase() + state.slice(1) : "Unknown";
}

function stateColor(state: string) {
  if (state === "applied") return "success" as const;
  if (state === "proposed") return "info" as const;
  if (state === "closed") return "default" as const;
  return "warning" as const;
}

function decisionTitle(decision: LevelAuditDecision) {
  const event = decision.current;
  return `${displaySource(event.decision_source)} ${displayKind(
    event.decision_kind
  )}: ${event.previous_level || "Unconfigured"} → ${
    event.new_level || "Unknown"
  }`;
}

function AuditLink({
  href,
  children,
}: {
  href: string | null;
  children: ReactNode;
}) {
  if (!isSafeHttpUrl(href)) return null;
  return (
    <Link href={href} target="_blank" rel="noopener noreferrer">
      {children} ↗
    </Link>
  );
}

function DecisionDetails({ decision }: { decision: LevelAuditDecision }) {
  const event = decision.current;
  const reason = firstAuditValue(decision, "reason");
  const proposalUrl = firstAuditValue(decision, "proposal_pr_url");
  const approvalUrl = firstAuditValue(decision, "approval_pr_url");
  const configurationCommitUrl = firstAuditValue(
    decision,
    "configuration_commit_url"
  );
  const configurationCommitSha = firstAuditValue(
    decision,
    "configuration_commit_sha"
  );
  const actor = firstAuditValue(decision, "decision_actor");
  const recordedBy = firstAuditValue(decision, "recorded_by");
  let criteria = null;
  for (const candidate of [...decision.events].reverse()) {
    criteria = parseCriteriaSnapshot(
      candidate.criteria_snapshot_json,
      candidate.criteria_schema_version
    );
    if (criteria) break;
  }
  const windowEvent = [...decision.events]
    .reverse()
    .find(
      (candidate) =>
        candidate.evaluation_window_start && candidate.evaluation_window_end
    );
  const appliedEvent = [...decision.events]
    .reverse()
    .find((candidate) => candidate.event_state === "applied");

  return (
    <Paper
      aria-live="polite"
      elevation={0}
      sx={{ border: 1, borderColor: "divider", p: 2 }}
    >
      <Stack spacing={1.5}>
        <Box
          display="flex"
          justifyContent="space-between"
          alignItems="flex-start"
          flexWrap="wrap"
          gap={1}
        >
          <Box>
            <Typography
              variant="overline"
              color="text.secondary"
              lineHeight={1.2}
            >
              Selected audit decision
            </Typography>
            <Typography variant="subtitle1" fontWeight={600}>
              {decisionTitle(decision)}
            </Typography>
          </Box>
          <Chip
            label={displayState(event.event_state)}
            color={stateColor(event.event_state)}
            size="small"
            variant="outlined"
          />
        </Box>

        {reason ? (
          <Box
            sx={{
              borderLeft: 3,
              borderColor:
                event.decision_kind === "demotion"
                  ? "error.main"
                  : "primary.main",
              bgcolor: "action.hover",
              p: 1.25,
            }}
          >
            <Typography variant="body2">
              <strong>Reason:</strong> {reason}
            </Typography>
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No decision reason was recorded.
          </Typography>
        )}

        <Box
          display="grid"
          gridTemplateColumns={{
            xs: "1fr",
            sm: "repeat(2, minmax(0, 1fr))",
          }}
          gap={1.5}
        >
          <Box>
            <Typography variant="caption" color="text.secondary">
              Decision source
            </Typography>
            <Typography variant="body2">
              {displaySource(event.decision_source)}
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Decision actor
            </Typography>
            <Typography variant="body2">{actor ?? "Not recorded"}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Recorded by
            </Typography>
            <Typography variant="body2">
              {recordedBy ?? "Not recorded"}
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Effective at
            </Typography>
            <Typography variant="body2">
              {appliedEvent?.effective_at ? (
                <LocalTimeHuman timestamp={appliedEvent.effective_at} />
              ) : (
                "Not applied"
              )}
            </Typography>
          </Box>
          {windowEvent && (
            <Box gridColumn={{ sm: "span 2" }}>
              <Typography variant="caption" color="text.secondary">
                Evaluation window
              </Typography>
              <Typography variant="body2">
                <LocalTimeHuman
                  timestamp={windowEvent.evaluation_window_start!}
                />{" "}
                –{" "}
                <LocalTimeHuman
                  timestamp={windowEvent.evaluation_window_end!}
                />
              </Typography>
            </Box>
          )}
        </Box>

        {(proposalUrl || approvalUrl || configurationCommitSha) && (
          <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
            <AuditLink href={proposalUrl}>Proposal</AuditLink>
            <AuditLink href={approvalUrl}>Approval record</AuditLink>
            {isSafeHttpUrl(configurationCommitUrl) ? (
              <AuditLink href={configurationCommitUrl}>
                Applied configuration{" "}
                {configurationCommitSha?.slice(0, 12) ?? "commit"}
              </AuditLink>
            ) : configurationCommitSha ? (
              <Typography variant="body2">
                Applied configuration: {configurationCommitSha}
              </Typography>
            ) : null}
          </Stack>
        )}

        {criteria ? (
          <TableContainer>
            <Table size="small" aria-label="Recorded decision criteria">
              <TableHead>
                <TableRow>
                  <TableCell>Criterion</TableCell>
                  <TableCell align="right">Requirement</TableCell>
                  <TableCell align="right">Recorded value</TableCell>
                  <TableCell align="right">State</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {criteria.map((criterion, index) => (
                  <TableRow key={`${criterion.name}-${index}`}>
                    <TableCell>{criterion.name}</TableCell>
                    <TableCell align="right">{criterion.target}</TableCell>
                    <TableCell
                      align="right"
                      sx={{
                        color:
                          criterion.verdict === "failed"
                            ? "error.main"
                            : undefined,
                        fontWeight:
                          criterion.verdict === "failed" ? 600 : undefined,
                      }}
                    >
                      {criterion.observed}
                    </TableCell>
                    <TableCell align="right">{criterion.verdict}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No compatible criterion snapshot was recorded for this decision.
          </Typography>
        )}

        <Box>
          <Typography variant="caption" color="text.secondary">
            Lifecycle
          </Typography>
          <Stack spacing={0.5} sx={{ mt: 0.5 }}>
            {decision.events.map((lifecycleEvent) => (
              <Box
                key={lifecycleEvent.event_id}
                display="flex"
                gap={1}
                alignItems="center"
              >
                <Chip
                  label={displayState(lifecycleEvent.event_state)}
                  color={stateColor(lifecycleEvent.event_state)}
                  size="small"
                  variant="outlined"
                />
                <Typography variant="body2" color="text.secondary">
                  <LocalTimeHuman
                    timestamp={auditDisplayTime(lifecycleEvent)}
                  />
                </Typography>
              </Box>
            ))}
          </Stack>
        </Box>
      </Stack>
    </Paper>
  );
}

type HistoryEntry =
  | {
      id: string;
      kind: "audit";
      timestamp: string;
      decision: LevelAuditDecision;
    }
  | {
      id: string;
      kind: "observed";
      timestamp: string;
      event: LevelHistoryEvent;
    };

function historyEntries(
  decisions: LevelAuditDecision[],
  events: LevelHistoryEvent[]
): HistoryEntry[] {
  return [
    ...decisions.map((decision) => ({
      id: `audit:${decision.decision_id}`,
      kind: "audit" as const,
      timestamp: auditDisplayTime(decision.current),
      decision,
    })),
    ...events.map((event, index) => ({
      id: `observed:${event.changed_at}:${event.new_level}:${index}`,
      kind: "observed" as const,
      timestamp: event.changed_at,
      event,
    })),
  ].sort(
    (left, right) =>
      right.timestamp.localeCompare(left.timestamp) ||
      right.id.localeCompare(left.id)
  );
}

function ObservedDetails({ event }: { event: LevelHistoryEvent }) {
  return (
    <Paper
      aria-live="polite"
      elevation={0}
      sx={{ border: 1, borderColor: "divider", p: 2 }}
    >
      <Stack spacing={1.5}>
        <Box
          display="flex"
          justifyContent="space-between"
          alignItems="flex-start"
          flexWrap="wrap"
          gap={1}
        >
          <Box>
            <Typography
              variant="overline"
              color="text.secondary"
              lineHeight={1.2}
            >
              Selected history event
            </Typography>
            <Typography variant="subtitle1" fontWeight={600}>
              Observed configured level: {event.previous_level} →{" "}
              {event.new_level}
            </Typography>
          </Box>
          <Chip
            label="Dispatch observed"
            color="info"
            size="small"
            variant="outlined"
          />
        </Box>

        <Box
          sx={{
            borderLeft: 3,
            borderColor: "info.main",
            bgcolor: "action.hover",
            p: 1.25,
          }}
        >
          <Typography variant="body2">
            This level change was inferred from CRCR dispatch records. No
            durable audit decision was recorded for this historical event.
          </Typography>
        </Box>

        <Box
          display="grid"
          gridTemplateColumns={{
            xs: "1fr",
            sm: "repeat(2, minmax(0, 1fr))",
          }}
          gap={1.5}
        >
          <Box>
            <Typography variant="caption" color="text.secondary">
              Evidence source
            </Typography>
            <Typography variant="body2">CRCR dispatch records</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Observed at
            </Typography>
            <Typography variant="body2">
              <LocalTimeHuman timestamp={event.changed_at} />
            </Typography>
          </Box>
        </Box>

        <Typography variant="body2" color="text.secondary">
          Decision reason, actor, criteria, and PR links are available only for
          configured-level changes recorded by the audit workflow.
        </Typography>
      </Stack>
    </Paper>
  );
}

export default function CrcrLevelAudit({
  repoFullName,
}: {
  repoFullName: string;
}) {
  const {
    decisions,
    error: auditError,
    loaded: auditLoaded,
  } = useLevelAudit(repoFullName);
  const {
    events,
    error: historyError,
    loaded: historyLoaded,
  } = useLevelHistory(repoFullName);
  const [expanded, setExpanded] = useState(false);
  const [selectedEntryId, setSelectedEntryId] = useState<string>();
  const entries = historyEntries(decisions, events);
  const selectedEntry =
    entries.find((entry) => entry.id === selectedEntryId) ?? entries[0];

  if (!auditLoaded || !historyLoaded) {
    return <Skeleton variant="rectangular" height={80} />;
  }

  return (
    <Accordion
      disableGutters
      elevation={1}
      expanded={expanded}
      onChange={(_event, isExpanded) => setExpanded(isExpanded)}
      sx={{ "&:before": { display: "none" } }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 2 }}>
        <Box
          display="flex"
          justifyContent="space-between"
          alignItems="center"
          flexWrap="wrap"
          gap={1}
          width="100%"
        >
          <Typography variant="h6">Configured-Level History</Typography>
          <Chip
            label={`${
              historyError
                ? "Dispatch history unavailable"
                : `${events.length} observed event${
                    events.length === 1 ? "" : "s"
                  }`
            } · ${
              auditError
                ? "Audit unavailable"
                : `${decisions.length} audit decision${
                    decisions.length === 1 ? "" : "s"
                  }`
            }`}
            size="small"
            variant="outlined"
          />
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 2, pb: 2 }}>
        <Stack spacing={1.5}>
          <Typography variant="caption" color="text.secondary">
            Select a level event to inspect the available evidence. Audit-backed
            decisions preserve their lifecycle, actor, references, and recorded
            criteria; older dispatch-observed events identify the level change
            without implying a decision record exists.
          </Typography>

          {historyError && (
            <Typography variant="body2" color="error">
              Dispatch-observed history is temporarily unavailable.
            </Typography>
          )}
          {auditError && (
            <Typography variant="body2" color="error">
              The configured-level audit is temporarily unavailable.
            </Typography>
          )}

          {!selectedEntry ? (
            <Typography variant="body2" color="text.secondary">
              No configured-level events have been recorded for this repository.
            </Typography>
          ) : (
            <Box
              display="grid"
              gridTemplateColumns={{
                xs: "1fr",
                md: "minmax(0, 0.85fr) minmax(0, 1.35fr)",
              }}
              gap={3}
            >
              <Stack spacing={0}>
                {entries.map((entry) => {
                  const decision =
                    entry.kind === "audit" ? entry.decision : undefined;
                  const event = decision?.current;
                  const previousLevel =
                    entry.kind === "audit"
                      ? entry.decision.current.previous_level
                      : entry.event.previous_level;
                  const newLevel =
                    entry.kind === "audit"
                      ? entry.decision.current.new_level
                      : entry.event.new_level;
                  const selected = entry.id === selectedEntry.id;
                  return (
                    <ListItemButton
                      key={entry.id}
                      selected={selected}
                      aria-pressed={selected}
                      onClick={() => setSelectedEntryId(entry.id)}
                      sx={{
                        display: "grid",
                        gridTemplateColumns: "20px minmax(0, 1fr)",
                        columnGap: 1,
                        alignItems: "start",
                        borderRadius: 1,
                        px: 1,
                        py: 0.75,
                      }}
                    >
                      <Box
                        sx={{
                          width: 10,
                          height: 10,
                          mt: 0.5,
                          borderRadius: "50%",
                          bgcolor:
                            event?.decision_kind === "promotion"
                              ? "success.main"
                              : event?.decision_kind === "demotion"
                              ? "error.main"
                              : "info.main",
                        }}
                      />
                      <Stack spacing={0.25}>
                        <Typography variant="caption" color="text.secondary">
                          <LocalTimeHuman timestamp={entry.timestamp} />
                        </Typography>
                        <Typography variant="body2" fontWeight={600}>
                          {previousLevel || "Unconfigured"} → {newLevel}
                        </Typography>
                        {event ? (
                          <Stack
                            direction="row"
                            spacing={0.5}
                            flexWrap="wrap"
                            useFlexGap
                          >
                            <Chip
                              label={`${displaySource(
                                event.decision_source
                              )} ${displayKind(
                                event.decision_kind
                              ).toLowerCase()}`}
                              color={kindColor(event.decision_kind)}
                              size="small"
                              variant="outlined"
                            />
                            <Chip
                              label={displayState(event.event_state)}
                              color={stateColor(event.event_state)}
                              size="small"
                              variant="outlined"
                            />
                          </Stack>
                        ) : (
                          <Chip
                            label="Dispatch observed"
                            color="info"
                            size="small"
                            variant="outlined"
                          />
                        )}
                      </Stack>
                    </ListItemButton>
                  );
                })}
              </Stack>
              {selectedEntry.kind === "audit" ? (
                <DecisionDetails decision={selectedEntry.decision} />
              ) : (
                <ObservedDetails event={selectedEntry.event} />
              )}
            </Box>
          )}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
