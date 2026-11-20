import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Alert,
  alpha,
  Button,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import type {
  ReleaseBoard,
  ReleaseMilestoneItems,
  ReleaseStep,
} from "lib/api/releases/types";
import {
  releaseErrorMessage,
  type ReleaseResource,
} from "lib/releasePortal/api";
import { isSafeReleaseUrl } from "lib/releasePortal/url";
import { Fragment, useState } from "react";
import {
  ReleaseEvidenceCell,
  ReleaseRcChip,
  ReleaseStatusChip,
  ReleaseTier,
} from "./ReleaseComponents";

type ReleasePhase = ReleaseBoard["phases"][number];

const MILESTONE_STEP_IDS = new Set(["1.2", "2.9", "3.1"]);

function label(value: string): string {
  return value.replaceAll("_", " ");
}

function StepGuidance({
  step,
  statuses,
}: {
  step: ReleaseStep;
  statuses: Map<string, ReleaseStep["status"]>;
}) {
  if (step.status === "done") return null;

  const unmet = step.depends_on.filter((id) => statuses.get(id) !== "done");
  const runbook = step.runbook && Object.entries(step.runbook)[0];
  if (step.manual === null && !runbook && unmet.length === 0) {
    return null;
  }

  return (
    <Stack spacing={0.25} sx={{ mt: 0.5 }}>
      {step.manual !== null && (
        <Typography variant="body2" color="text.secondary">
          What to check: {step.manual.what_to_check}{" "}
          {isSafeReleaseUrl(step.manual.link) && (
            <Link href={step.manual.link} rel="noreferrer" target="_blank">
              Open check
            </Link>
          )}
        </Typography>
      )}
      {runbook && (
        <Typography variant="body2" color="text.secondary">
          Runbook:{" "}
          {runbook[0] === "url" ? (
            isSafeReleaseUrl(runbook[1]) ? (
              <Link href={runbook[1]} rel="noreferrer" target="_blank">
                Open runbook
              </Link>
            ) : (
              "Unavailable"
            )
          ) : (
            `${runbook[0]} ${runbook[1]}`
          )}
        </Typography>
      )}
      {unmet.length > 0 && (
        <Typography variant="body2" color="text.secondary">
          Waits for {unmet.join(", ")}
        </Typography>
      )}
    </Stack>
  );
}

function MilestoneItems({
  milestone,
}: {
  milestone: ReleaseResource<ReleaseMilestoneItems>;
}) {
  if (milestone.data === undefined) {
    if (milestone.error !== undefined) {
      return (
        <Alert
          severity="error"
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => void milestone.retry()}
            >
              Retry
            </Button>
          }
        >
          Could not load outstanding milestone items:{" "}
          {releaseErrorMessage(milestone.error)}
        </Alert>
      );
    }
    return (
      <Typography color="text.secondary" variant="body2">
        Loading outstanding milestone items…
      </Typography>
    );
  }

  if (milestone.data.milestone === null) {
    return (
      <Typography color="text.secondary" variant="body2">
        Outstanding milestone items have not been scanned yet.
      </Typography>
    );
  }

  if (milestone.data.outstanding.length === 0) {
    return (
      <Typography color="text.secondary" variant="body2">
        No outstanding milestone items.
      </Typography>
    );
  }

  return (
    <TableContainer component={Paper} variant="outlined">
      <Table aria-label="Outstanding milestone items" size="small">
        <TableHead>
          <TableRow>
            <TableCell>Item</TableCell>
            <TableCell>Kind</TableCell>
            <TableCell>Title</TableCell>
            <TableCell>State</TableCell>
            <TableCell>Reason</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {milestone.data.outstanding.map((item) => (
            <TableRow key={`${item.kind}-${item.number}`}>
              <TableCell>
                {isSafeReleaseUrl(item.url) ? (
                  <Link href={item.url} rel="noreferrer" target="_blank">
                    #{item.number}
                  </Link>
                ) : (
                  `#${item.number}`
                )}
              </TableCell>
              <TableCell>{label(item.kind)}</TableCell>
              <TableCell sx={{ maxWidth: 480, overflowWrap: "anywhere" }}>
                {item.title}
              </TableCell>
              <TableCell>{label(item.state)}</TableCell>
              <TableCell>{label(item.reason)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export function ReleaseStepTable({
  phases,
  milestone,
}: {
  phases: ReleasePhase[];
  milestone: ReleaseResource<ReleaseMilestoneItems>;
}) {
  const [expandedByPhase, setExpandedByPhase] = useState<
    Record<number, boolean>
  >({});
  const [expandedStepIds, setExpandedStepIds] = useState<
    Record<string, boolean>
  >({});
  const statuses = new Map(
    phases.flatMap((phase) =>
      phase.steps.map((step) => [step.id, step.status] as const)
    )
  );

  return (
    <TableContainer component={Paper} variant="outlined">
      <Table size="small" aria-label="Release steps">
        <TableHead>
          <TableRow>
            <TableCell>ID</TableCell>
            <TableCell>Step</TableCell>
            <TableCell>RC</TableCell>
            <TableCell>Evidence</TableCell>
            <TableCell>Tier</TableCell>
            <TableCell>Status</TableCell>
          </TableRow>
        </TableHead>
        {phases.map((phase) => {
          const expanded = expandedByPhase[phase.id] ?? !phase.collapsed;
          const counted = phase.steps.filter((step) => !step.informational);
          const done = counted.filter((step) => step.status === "done").length;
          return (
            <TableBody key={phase.id}>
              <TableRow sx={{ bgcolor: "action.hover" }}>
                <TableCell
                  component="th"
                  scope="rowgroup"
                  colSpan={6}
                  sx={{ py: 0.5 }}
                >
                  <Button
                    color="inherit"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Collapse" : "Expand"} phase ${
                      phase.id
                    }: ${phase.name}`}
                    onClick={() =>
                      setExpandedByPhase((current) => ({
                        ...current,
                        [phase.id]: !expanded,
                      }))
                    }
                    startIcon={
                      expanded ? <ExpandMoreIcon /> : <ChevronRightIcon />
                    }
                    sx={{ justifyContent: "flex-start", textAlign: "left" }}
                  >
                    <Typography component="span" fontWeight={600}>
                      Phase {phase.id}: {phase.name}
                    </Typography>
                    <Typography
                      component="span"
                      variant="body2"
                      color="text.secondary"
                      sx={{ ml: 1 }}
                    >
                      {done}/{counted.length} done
                    </Typography>
                  </Button>
                </TableCell>
              </TableRow>
              {expanded &&
                phase.steps.map((step) => {
                  const hasMilestoneItems = MILESTONE_STEP_IDS.has(step.id);
                  const detailsExpanded = expandedStepIds[step.id] ?? false;
                  const detailsId = `milestone-items-${step.id}`;
                  return (
                    <Fragment key={step.id}>
                      <TableRow
                        sx={
                          step.blocking
                            ? {
                                bgcolor: (theme) =>
                                  alpha(theme.palette.error.main, 0.14),
                              }
                            : undefined
                        }
                      >
                        <TableCell>{step.id}</TableCell>
                        <TableCell sx={{ minWidth: 220 }}>
                          <Typography fontWeight={500}>{step.name}</Typography>
                          <StepGuidance step={step} statuses={statuses} />
                          {hasMilestoneItems && (
                            <Button
                              aria-expanded={detailsExpanded}
                              aria-label={`Outstanding milestone items for step ${step.id}`}
                              onClick={() =>
                                setExpandedStepIds((current) => ({
                                  ...current,
                                  [step.id]: !detailsExpanded,
                                }))
                              }
                              size="small"
                              startIcon={
                                detailsExpanded ? (
                                  <ExpandMoreIcon />
                                ) : (
                                  <ChevronRightIcon />
                                )
                              }
                              sx={{ mt: 0.5 }}
                            >
                              Outstanding items
                            </Button>
                          )}
                        </TableCell>
                        <TableCell>
                          <ReleaseRcChip rc={step.rc} />
                        </TableCell>
                        <TableCell
                          sx={{ maxWidth: 360, overflowWrap: "anywhere" }}
                        >
                          <ReleaseEvidenceCell evidence={step.evidence} />
                        </TableCell>
                        <TableCell>
                          <ReleaseTier tier={step.tier} />
                        </TableCell>
                        <TableCell
                          sx={
                            step.blocking
                              ? { color: "error.main", fontWeight: 600 }
                              : undefined
                          }
                        >
                          {step.informational ? (
                            "info"
                          ) : (
                            <ReleaseStatusChip status={step.status} />
                          )}
                        </TableCell>
                      </TableRow>
                      {hasMilestoneItems && detailsExpanded && (
                        <TableRow>
                          <TableCell colSpan={6} id={detailsId}>
                            <MilestoneItems milestone={milestone} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
            </TableBody>
          );
        })}
      </Table>
    </TableContainer>
  );
}
