// The GREEN LIGHT panel on the HUD's commit and PR pages. PR-scoped, not
// commit-scoped: mergebot rebases, so a landed commit never carries the
// reviewed sha and qualifying the verdict by commit would be misleading.
// Headline wording is shared with greenlightRender.ts so the HUD and the Dr.CI
// comment cannot disagree about what a status means.
//
// The model's `message` renders as a text node, which is the containment --
// nothing here may route it through dangerouslySetInnerHTML or a markdown
// renderer.

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

// The one reason code meaning "nothing to report". A literal because the enum
// lives in Python; this is a display rule keyed off one member, not a copy of
// the set.
const LAND_REDUNDANT_REASON = "clean";

// eval_job is a database column, so anchor the host: both a userinfo prefix and
// a lookalike domain satisfy a mere "contains github.com".
const SAFE_JOB_URL_RE = /^https:\/\/github\.com\/[^\s()<>"'\\]+$/;

interface Described {
  headline: string;
  /** Fixed prose for states that carry no model message. */
  body: string;
  /** The row's own reason for a verdict; the markers name themselves instead. */
  reason: string;
}

/** Mirrors renderGreenlightSection: a status with no case here has no panel. */
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
        // "clean" is the only reason a LAND may carry, so printing it just
        // restates the headline. Keyed on the pair, not the status: a LAND
        // carrying anything else is anomalous and worth showing.
        reason: rowReason === LAND_REDUNDANT_REASON ? "" : rowReason,
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
      // An in-flight row past the window means the terminal emit was lost.
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

/** Renders nothing when GreenLight has no state for this PR. */
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
  // `message` is an unbounded ClickHouse String; same cap as the Dr.CI render.
  const message = Array.from(state.message ?? "")
    .slice(0, GREENLIGHT_MESSAGE_CAP)
    .join("");
  const jobUrl = (state.eval_job ?? "").trim();

  return (
    <Accordion
      disableGutters
      // defaultExpanded is read once per mount, and the PR page's picker
      // switches commits under this component.
      key={`${normalizeSha(sha)}:${state.status}`}
      defaultExpanded={approved}
      sx={{ mt: 2, mb: 2 }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreIcon />}
        aria-label={
          approved
            ? "Collapse the Green Light verdict"
            : "Expand the Green Light verdict"
        }
        sx={{
          bgcolor: "action.hover",
          "&:hover": { bgcolor: "action.selected" },
          // MUI's flex-grow: 1 would park the chevron at the far right edge of
          // the page, yards from the text it belongs to.
          "& .MuiAccordionSummary-content": { flexGrow: 0, marginRight: 1 },
          justifyContent: "flex-start",
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
          <GreenLightIcon status={state.status} size={14} />
          <Typography fontWeight="bold">GREEN LIGHT</Typography>
          <Typography color="text.secondary">{described.headline}</Typography>
          {/* On the summary: a non-approved panel stays collapsed, and the
          reason is the whole of what a NO_LAND adds over its headline. */}
          {reason && (
            <Typography variant="body2" color="text.secondary">
              <code>{reason}</code>
            </Typography>
          )}
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
