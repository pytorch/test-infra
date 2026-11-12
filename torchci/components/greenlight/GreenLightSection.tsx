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
  describeGreenlightStatus,
  isGreenlightApproved,
  normalizeSha,
  selectMessageView,
  selectStateForSha,
} from "lib/greenlight/greenlightHudState";
import { GREENLIGHT_SECTION_HEADER } from "lib/greenlight/greenlightRender";
import { isReportableStatus } from "lib/greenlight/greenlightReport";
import { useGreenlightPrHistory } from "lib/greenlight/useGreenlightPrHistory";

// eval_job is a database column, so anchor the host: both a userinfo prefix and
// a lookalike domain satisfy a mere "contains github.com".
const SAFE_JOB_URL_RE = /^https:\/\/github\.com\/[^\s()<>"'\\]+$/;

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

  const described = describeGreenlightStatus(
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
