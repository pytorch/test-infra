import { Box, Card, Chip, Link, Stack, Typography } from "@mui/material";
import type { ReleaseBoard, ReleaseStep } from "lib/api/releases/types";
import { STEP_STATUSES, TIERS } from "lib/api/releases/types";
import { isSafeReleaseUrl } from "lib/releasePortal/url";
import type { ReactNode } from "react";

export type ReleaseStatus = (typeof STEP_STATUSES)[number];
export type ReleaseTier = (typeof TIERS)[number];
type Evidence = ReleaseStep["evidence"];
type ReleaseLinks = ReleaseBoard["links"];

const STATUS_LABEL: Record<ReleaseStatus, string> = {
  done: "Done",
  blocked: "Blocked",
  in_progress: "In progress",
  todo: "To do",
};

const STATUS_COLOR: Record<
  ReleaseStatus,
  "default" | "error" | "info" | "success"
> = {
  done: "success",
  blocked: "error",
  in_progress: "info",
  todo: "default",
};

const LINK_LABELS: Record<string, string> = {
  artifacts: "Artifacts",
  build_matrix: "Build matrix",
  docs: "Docs",
  libtorch: "LibTorch",
  milestone: "Milestone",
  release_notes: "Release notes",
  tracker_issue: "Tracker",
  validation_issue: "Validation",
  wheels: "Wheels",
};

function humanizeLinkLabel(key: string): string {
  return LINK_LABELS[key] ?? key.replace(/_/g, " ");
}

export function ReleaseStatCard({
  label,
  value,
  accent = "default",
}: {
  label: string;
  value: ReactNode;
  accent?: "default" | "blocked";
}) {
  return (
    <Card
      data-testid={`release-stat-${accent}`}
      variant="outlined"
      sx={{
        borderLeft: 4,
        borderLeftColor: accent === "blocked" ? "error.main" : "divider",
        minWidth: 148,
        p: 1.5,
      }}
    >
      <Typography color="text.secondary" variant="caption">
        {label}
      </Typography>
      <Typography component="div" variant="h6">
        {value}
      </Typography>
    </Card>
  );
}

export function ReleaseStatusChip({ status }: { status: ReleaseStatus }) {
  return (
    <Chip
      color={STATUS_COLOR[status]}
      label={STATUS_LABEL[status]}
      size="small"
      variant={status === "todo" ? "outlined" : "filled"}
    />
  );
}

export function ReleaseTier({ tier }: { tier: ReleaseTier }) {
  return (
    <Box
      aria-label={`Automation tier ${tier}`}
      component="span"
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        display: "inline-flex",
        fontFamily: "monospace",
        fontSize: "0.875rem",
        justifyContent: "center",
        minWidth: "1.75rem",
        px: 0.5,
      }}
    >
      {tier}
    </Box>
  );
}

export function ReleaseRcChip({ rc }: { rc: string | null }) {
  if (rc === null) {
    return null;
  }

  return <Chip label={rc.toUpperCase()} size="small" variant="outlined" />;
}

export function ReleaseEvidenceCell({ evidence }: { evidence: Evidence }) {
  if (evidence === null) {
    return <Typography color="text.secondary">Not checked</Typography>;
  }

  if (!isSafeReleaseUrl(evidence.url)) {
    return <Typography>{evidence.text}</Typography>;
  }

  return (
    <Link href={evidence.url} rel="noreferrer" target="_blank">
      {evidence.text}
    </Link>
  );
}

export function ReleaseLinksRow({ links }: { links: ReleaseLinks }) {
  const availableLinks = Object.entries(links).filter(
    (entry): entry is [string, string] => isSafeReleaseUrl(entry[1])
  );

  if (availableLinks.length === 0) {
    return null;
  }

  return (
    <Stack aria-label="Release links" direction="row" flexWrap="wrap" gap={1}>
      {availableLinks.map(([key, url]) => (
        <Link href={url} key={key} rel="noreferrer" target="_blank">
          {humanizeLinkLabel(key)}
        </Link>
      ))}
    </Stack>
  );
}
