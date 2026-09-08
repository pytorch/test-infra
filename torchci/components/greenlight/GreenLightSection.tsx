// The GREEN LIGHT panel on the HUD's commit and PR pages: what GreenLight
// decided about the PR, and the model's stated reason for it.
//
// Deliberately PR-scoped, not commit-scoped. A landed trunk commit never carries
// the sha GreenLight reviewed -- mergebot rebases, so the sha changes while the
// change does not -- and an early version of this qualified every such verdict
// as belonging to "an earlier commit", which was both wrong and alarming. The
// per-commit detail belongs in the PR page's picker, which marks exactly the
// pushes GreenLight reviewed; see selectStateForSha.
//
// The same misc.greenlight_pr_state row Dr.CI renders into the PR comment, shown
// on the HUD instead. The wording is shared with that renderer
// (greenlightRender.ts headline constants) so the two surfaces cannot disagree
// about what a status means; the layout is not, because a comment section folded
// into Dr.CI's own <details> is a different job from a panel on a page.
//
// The model's `message` is rendered as a text node inside a monospace block.
// That is the containment: React escapes it, so unlike the markdown comment path
// it needs no fence and no @-mention defanging -- but nothing here may route it
// through dangerouslySetInnerHTML or a markdown renderer.

import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Link,
  Stack,
  Typography,
} from "@mui/material";
import GreenLightIcon from "components/greenlight/GreenLightIcon";
import {
  isGreenlightApproved,
  normalizeSha,
  selectStateForSha,
} from "lib/greenlight/greenlightHudState";
import {
  GREENLIGHT_INCOMPLETE_HEADLINE,
  GREENLIGHT_LAND_HEADLINE,
  GREENLIGHT_MESSAGE_CAP,
  GREENLIGHT_NO_LAND_HEADLINE,
  GREENLIGHT_REVERTED_BODY,
  GREENLIGHT_REVERTED_HEADLINE,
  GREENLIGHT_REVIEWING_BODY,
  GREENLIGHT_REVIEWING_HEADLINE,
  GREENLIGHT_STALLED_REASON,
  GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED,
  GREENLIGHT_STATUS_AI_REVIEW_STARTED,
  GREENLIGHT_STATUS_CANCELLED,
  GREENLIGHT_STATUS_FAILED,
  GREENLIGHT_STATUS_LAND,
  GREENLIGHT_STATUS_NO_LAND,
  GREENLIGHT_STATUS_REVERTED,
} from "lib/greenlight/greenlightRender";
import { isInProgressStale } from "lib/greenlight/greenlightStaleness";
import { useGreenlightPrHistory } from "lib/greenlight/useGreenlightPrHistory";

// Same host anchoring as greenlightRender's SAFE_JOB_URL_RE: a userinfo prefix
// (https://u:p@github.com/) and a lookalike host (https://github.com.evil/) both
// satisfy a mere "contains github.com", and eval_job is a database column.
const SAFE_JOB_URL_RE = /^https:\/\/github\.com\/[^\s()<>"'\\]+$/;

interface Described {
  headline: string;
  /** Fixed prose for states the row carries no model message for. */
  body: string;
  /**
   * The reason to display, which is the row's own `reason` only for a verdict.
   * The marker statuses carry an empty one and name themselves instead, exactly
   * as comment_format.marker_body does.
   */
  reason: string;
}

/**
 * How to present one row. Mirrors renderGreenlightSection's branches, headline
 * for headline: a status with no case here has no panel to show, just as it has
 * no Dr.CI section.
 */
function describeStatus(
  status: string,
  rowReason: string,
  version: string,
  now: Date
): Described | undefined {
  switch (status) {
    case GREENLIGHT_STATUS_LAND:
      return {
        headline: GREENLIGHT_LAND_HEADLINE,
        body: "",
        reason: rowReason,
      };
    case GREENLIGHT_STATUS_NO_LAND:
      return {
        headline: GREENLIGHT_NO_LAND_HEADLINE,
        body: "",
        reason: rowReason,
      };
    case GREENLIGHT_STATUS_REVERTED:
      return {
        headline: GREENLIGHT_REVERTED_HEADLINE,
        body: GREENLIGHT_REVERTED_BODY,
        reason: "",
      };
    case GREENLIGHT_STATUS_AI_REVIEW_STARTED:
    case GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED:
      // An in-flight row that outlived the window means the terminal emit was
      // lost. Saying "in progress" for as long as the row stands would be worse
      // than admitting the run is presumed gone.
      return isInProgressStale(version, now)
        ? {
            headline: GREENLIGHT_INCOMPLETE_HEADLINE,
            body: "",
            reason: GREENLIGHT_STALLED_REASON,
          }
        : {
            headline: GREENLIGHT_REVIEWING_HEADLINE,
            body: GREENLIGHT_REVIEWING_BODY,
            reason: "",
          };
    case GREENLIGHT_STATUS_CANCELLED:
    case GREENLIGHT_STATUS_FAILED:
      return {
        headline: GREENLIGHT_INCOMPLETE_HEADLINE,
        body: "",
        reason: status.toLowerCase(),
      };
    default:
      return undefined;
  }
}

/**
 * Renders nothing when the repo is outside GREENLIGHT_REPOS, when the commit has
 * no PR, or when GreenLight has no state for that PR -- an absent panel says
 * "GreenLight did not weigh in", which is true and is what a reader needs.
 */
export default function GreenLightSection({
  repoOwner,
  repoName,
  prNumber,
  sha,
}: {
  repoOwner: string;
  repoName: string;
  prNumber: number | null | undefined;
  sha: string;
}) {
  const { data: rows } = useGreenlightPrHistory(repoOwner, repoName, prNumber);
  const state = selectStateForSha(rows, sha);
  if (state === undefined) {
    return null;
  }

  const described = describeStatus(
    state.status.trim(),
    state.reason ?? "",
    state.version,
    new Date()
  );
  if (described === undefined) {
    return null;
  }

  const approved = isGreenlightApproved(state.status);
  const reason = described.reason;
  // The same cap the Dr.CI render applies, for the same reason: `message` is an
  // unbounded ClickHouse String and nothing upstream bounds what a model wrote.
  const message = Array.from(state.message ?? "")
    .slice(0, GREENLIGHT_MESSAGE_CAP)
    .join("");
  const jobUrl = (state.eval_job ?? "").trim();

  return (
    <Accordion
      disableGutters
      // defaultExpanded is read once per mount, so without a key that changes
      // with the verdict the panel would keep whatever expand state the previous
      // commit left it in. That is reachable from the PR page, whose picker
      // switches commits under this component.
      key={`${normalizeSha(sha)}:${state.status}`}
      // Expanded when GreenLight approved, collapsed otherwise. An approval is
      // the claim a reader most needs to be able to check without a click; every
      // other state is either self-evident from the headline or a non-event.
      defaultExpanded={approved}
      sx={{ mt: 2, mb: 2 }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} alignItems="center">
          <GreenLightIcon status={state.status} size={14} />
          <Typography fontWeight="bold">GREEN LIGHT</Typography>
          <Typography color="text.secondary">{described.headline}</Typography>
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1}>
          {described.body && (
            <Typography variant="body2" color="text.secondary">
              {described.body}
            </Typography>
          )}
          {message && (
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1.5,
                borderRadius: 1,
                // Palette tokens rather than literals, so the block tracks both
                // modes (torchci/CLAUDE.md).
                bgcolor: "action.hover",
                color: "text.primary",
                fontSize: "0.8rem",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {message}
            </Box>
          )}
          {reason && (
            <Typography variant="body2" color="text.secondary">
              reason: <code>{reason}</code>
            </Typography>
          )}
          {SAFE_JOB_URL_RE.test(jobUrl) && (
            <Link
              href={jobUrl}
              target="_blank"
              rel="noreferrer"
              variant="body2"
            >
              Inference job
            </Link>
          )}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
