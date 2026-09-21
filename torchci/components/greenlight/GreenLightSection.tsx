// The GREEN LIGHT panel on the HUD's commit and PR pages. Shows the verdict for
// the commit on screen and only that one -- see selectStateForSha for the two
// ways a commit is matched. Headline wording is shared with greenlightRender.ts
// so the HUD and the Dr.CI comment cannot disagree about what a status means.
//
// Whatever part of the model's `message` reaches the DOM reaches it as a React
// text node, whether it renders as one block of text or as the bullet list in
// GreenLightOutline.tsx, and that is the containment: nothing on this surface
// may route it through dangerouslySetInnerHTML or a markdown renderer. Two MUI
// props reach the same place by a longer road and are equally out: spreading an
// object built from the message into a component forwards a
// dangerouslySetInnerHTML key straight through, and a `component` chosen from
// the message renders whatever tag it names.

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
import GreenLightOutline from "components/greenlight/GreenLightOutline";
import GreenLightReportButton from "components/greenlight/GreenLightReportButton";
import {
  isGreenlightApproved,
  normalizeSha,
  selectMessageView,
  selectStateForSha,
} from "lib/greenlight/greenlightHudState";
import {
  GREENLIGHT_INCOMPLETE_HEADLINE,
  GREENLIGHT_LAND_HEADLINE,
  GREENLIGHT_NO_LAND_HEADLINE,
  GREENLIGHT_REVERTED_BODY,
  GREENLIGHT_REVERTED_HEADLINE,
  GREENLIGHT_REVIEWING_BODY,
  GREENLIGHT_REVIEWING_HEADLINE,
  GREENLIGHT_SECTION_HEADER,
  GREENLIGHT_STALLED_REASON,
  GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED,
  GREENLIGHT_STATUS_AI_REVIEW_STARTED,
  GREENLIGHT_STATUS_CANCELLED,
  GREENLIGHT_STATUS_FAILED,
  GREENLIGHT_STATUS_LAND,
  GREENLIGHT_STATUS_NO_LAND,
  GREENLIGHT_STATUS_REVERTED,
} from "lib/greenlight/greenlightRender";
import { isReportableStatus } from "lib/greenlight/greenlightReport";
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
  /**
   * The status the mark should show, which is not always the row's own: a
   * stale in-flight row is presented as a run that did not complete, and the
   * lamp has to say the same thing as the headline beside it.
   */
  iconStatus: string;
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
        iconStatus: status,
        headline: GREENLIGHT_LAND_HEADLINE,
        body: "",
        // "clean" is the only reason a LAND may carry, so printing it just
        // restates the headline. Keyed on the pair, not the status: a LAND
        // carrying anything else is anomalous and worth showing.
        reason: rowReason === LAND_REDUNDANT_REASON ? "" : rowReason,
      };
    case GREENLIGHT_STATUS_NO_LAND:
      return {
        iconStatus: status,
        headline: GREENLIGHT_NO_LAND_HEADLINE,
        body: "",
        reason: rowReason,
      };
    case GREENLIGHT_STATUS_REVERTED:
      return {
        iconStatus: status,
        headline: GREENLIGHT_REVERTED_HEADLINE,
        body: GREENLIGHT_REVERTED_BODY,
        reason: "",
      };
    case GREENLIGHT_STATUS_AI_REVIEW_STARTED:
    case GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED:
      // An in-flight row past the window means the terminal emit was lost.
      return isInProgressStale(version, now)
        ? {
            // FAILED, not the row's in-flight status: it is the status whose
            // lamp and label already mean "did not complete", which is what
            // the headline here says.
            iconStatus: GREENLIGHT_STATUS_FAILED,
            headline: GREENLIGHT_INCOMPLETE_HEADLINE,
            body: "",
            reason: GREENLIGHT_STALLED_REASON,
          }
        : {
            iconStatus: status,
            headline: GREENLIGHT_REVIEWING_HEADLINE,
            body: GREENLIGHT_REVIEWING_BODY,
            reason: "",
          };
    case GREENLIGHT_STATUS_CANCELLED:
    case GREENLIGHT_STATUS_FAILED:
      return {
        iconStatus: status,
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
  committedAt,
}: {
  repoOwner: string;
  repoName: string;
  prNumber: number | null | undefined;
  sha: string;
  /**
   * `sha`'s committer date, supplied only where `sha` is a trunk commit. It is
   * what lets the query recover the reviewed head a ghstack stack member landed
   * from; without it that member's page matches nothing and shows no panel.
   */
  committedAt?: string;
}) {
  const { data: rows } = useGreenlightPrHistory(
    repoOwner,
    repoName,
    prNumber,
    committedAt ? { sha, committedAt } : undefined
  );
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
  const messageView = selectMessageView(state.message);
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
          <GreenLightIcon status={described.iconStatus} size={14} />
          <Typography fontWeight="bold">{GREENLIGHT_SECTION_HEADER}</Typography>
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
          {messageView.kind === "outline" ? (
            <GreenLightOutline outline={messageView.outline} />
          ) : (
            messageView.text && (
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
                {messageView.text}
              </Box>
            )
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
          {/* Offered on the two statuses that are a judgement, and on the row's
          own status rather than described.iconStatus: a stale in-flight row is
          PRESENTED as one that did not complete, and there is no verdict behind
          it to dispute. prNumber is re-checked because the panel also renders on
          commit pages, where a commit may have no PR. */}
          {isReportableStatus(state.status) &&
            prNumber != null &&
            prNumber > 0 && (
              <GreenLightReportButton
                repoOwner={repoOwner}
                repoName={repoName}
                prNumber={prNumber}
                // The reviewed commit, never the sha in the URL: on a landed
                // commit the two differ, and this is the one the verdict is about.
                sha={state.head_sha}
                status={state.status.trim()}
              />
            )}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
