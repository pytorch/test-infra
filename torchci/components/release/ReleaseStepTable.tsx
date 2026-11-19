import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
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
import type { ReleaseBoard, ReleaseStep } from "lib/api/releases/types";
import { isSafeReleaseUrl } from "lib/releasePortal/url";
import { useState } from "react";
import {
  ReleaseEvidenceCell,
  ReleaseRcChip,
  ReleaseStatusChip,
  ReleaseTier,
} from "./ReleaseComponents";

type ReleasePhase = ReleaseBoard["phases"][number];

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

export function ReleaseStepTable({ phases }: { phases: ReleasePhase[] }) {
  const [expandedByPhase, setExpandedByPhase] = useState<
    Record<number, boolean>
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
                phase.steps.map((step) => (
                  <TableRow
                    key={step.id}
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
                    </TableCell>
                    <TableCell>
                      <ReleaseRcChip rc={step.rc} />
                    </TableCell>
                    <TableCell sx={{ maxWidth: 360, overflowWrap: "anywhere" }}>
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
                ))}
            </TableBody>
          );
        })}
      </Table>
    </TableContainer>
  );
}
