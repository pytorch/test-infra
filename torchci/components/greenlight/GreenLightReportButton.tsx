// "This verdict is wrong" -- the HUD end of the Green Light policy feedback
// loop. Opens a dialog, takes the reporter's own words, and POSTs to
// /api/greenlight/report, which files the issue on pytorch/test-infra and puts
// it on the triage board.
//
// The browser sends only what identifies the row: repo, PR, and the commit on
// screen. It deliberately does NOT send the status, the reason, or the verdict
// message even though the panel is holding all three -- the issue is authored by
// a bot, and the server reads the verdict back from ClickHouse itself so a
// crafted POST cannot make that bot publish a verdict Green Light never reached.
//
// Every colour here comes from the MUI palette (`text.secondary`, `error`, the
// default Dialog and Button surfaces), so the dialog follows the HUD's dark and
// light modes without a mode check of its own.

import BugReportOutlinedIcon from "@mui/icons-material/BugReportOutlined";
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Link,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  GREENLIGHT_REPORT_COMMENT_CAP,
  GREENLIGHT_REPORT_OWNER,
  GREENLIGHT_REPORT_PROJECT_URL,
  GREENLIGHT_REPORT_REPO,
} from "lib/greenlight/greenlightReport";
import { useSession } from "next-auth/react";
import { useState } from "react";

type Phase =
  | { kind: "editing" }
  | { kind: "submitting" }
  | { kind: "failed"; error: string }
  | { kind: "filed"; issueUrl: string; addedToProject: boolean };

const GENERIC_ERROR = "Could not file the report. Please try again.";

/**
 * Pull the server's own message out of a failed response, falling back to
 * something generic. An API route error string is authored by this repo, but a
 * proxy or a crash can put anything in the body, so it is capped before it is
 * rendered and it is rendered as a React text node and nothing else.
 */
async function errorFrom(res: Response): Promise<string> {
  try {
    const body = await res.json();
    const error = body?.error;
    if (typeof error === "string" && error.trim() !== "") {
      return error.trim().slice(0, 300);
    }
  } catch {
    // Not JSON. The generic message is the honest one.
  }
  return GENERIC_ERROR;
}

export default function GreenLightReportButton({
  repoOwner,
  repoName,
  prNumber,
  sha,
  status,
}: {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  /** The commit whose verdict is on screen -- reviewed head or trunk commit. */
  sha: string;
  /** Shown in the dialog so the reporter can see what they are disputing. */
  status: string;
}) {
  const session = useSession();
  const loggedIn = session.status === "authenticated" && session.data !== null;

  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });

  const submitting = phase.kind === "submitting";
  const trimmed = comment.trim();
  const overCap = comment.length > GREENLIGHT_REPORT_COMMENT_CAP;

  function close() {
    if (submitting) {
      return;
    }
    setOpen(false);
    // Reset only once the dialog is closing, so a failed attempt keeps the text
    // the reporter typed while the error is still on screen.
    setComment("");
    setPhase({ kind: "editing" });
  }

  async function submit() {
    setPhase({ kind: "submitting" });
    try {
      const res = await fetch("/api/greenlight/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoOwner,
          repoName,
          prNumber,
          sha,
          comment: trimmed,
        }),
      });
      if (!res.ok) {
        setPhase({ kind: "failed", error: await errorFrom(res) });
        return;
      }
      const body = await res.json();
      if (typeof body?.issueUrl !== "string") {
        setPhase({ kind: "failed", error: GENERIC_ERROR });
        return;
      }
      setPhase({
        kind: "filed",
        issueUrl: body.issueUrl,
        addedToProject: body.addedToProject === true,
      });
    } catch (e) {
      setPhase({ kind: "failed", error: GENERIC_ERROR });
    }
  }

  return (
    <>
      <Tooltip
        title={
          loggedIn
            ? `Disagree with this ${status}? File a policy issue on ${GREENLIGHT_REPORT_OWNER}/${GREENLIGHT_REPORT_REPO} for the team to triage.`
            : "Log in to report a wrong Green Light verdict"
        }
      >
        {/* A disabled Button swallows the events Tooltip listens for. */}
        <span>
          <Button
            size="small"
            variant="outlined"
            color="inherit"
            disabled={!loggedIn}
            startIcon={<BugReportOutlinedIcon fontSize="small" />}
            onClick={() => setOpen(true)}
            sx={{ alignSelf: "flex-start", textTransform: "none" }}
          >
            Report wrong verdict
          </Button>
        </span>
      </Tooltip>

      <Dialog open={open} onClose={close} fullWidth maxWidth="sm">
        <DialogTitle>Report a wrong Green Light verdict</DialogTitle>
        <DialogContent>
          {phase.kind === "filed" ? (
            <Stack spacing={1.5} sx={{ mt: 1 }}>
              <Alert severity="success">
                Filed{" "}
                <Link href={phase.issueUrl} target="_blank" rel="noreferrer">
                  {phase.issueUrl}
                </Link>
              </Alert>
              {phase.addedToProject ? (
                <Typography variant="body2" color="text.secondary">
                  It is on the{" "}
                  <Link
                    href={GREENLIGHT_REPORT_PROJECT_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    GreenLight Policies Reviews
                  </Link>{" "}
                  board for triage.
                </Typography>
              ) : (
                <Alert severity="warning">
                  The issue was filed, but could not be added to the triage
                  board automatically. Please add it to{" "}
                  <Link
                    href={GREENLIGHT_REPORT_PROJECT_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    GreenLight Policies Reviews
                  </Link>{" "}
                  by hand.
                </Alert>
              )}
            </Stack>
          ) : (
            <Stack spacing={2} sx={{ mt: 1 }}>
              <TextField
                autoFocus
                multiline
                minRows={5}
                fullWidth
                label="What did Green Light get wrong?"
                placeholder="e.g. this only touches a test file that is already skipped on this platform, so it should have been approved."
                value={comment}
                disabled={submitting}
                onChange={(e) => setComment(e.target.value)}
                error={overCap}
                helperText={
                  overCap
                    ? `${comment.length} / ${GREENLIGHT_REPORT_COMMENT_CAP} characters`
                    : " "
                }
              />
              {phase.kind === "failed" && (
                <Alert severity="error">{phase.error}</Alert>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={close} disabled={submitting} color="inherit">
            {phase.kind === "filed" ? "Close" : "Cancel"}
          </Button>
          {phase.kind !== "filed" && (
            <Button
              variant="contained"
              onClick={submit}
              disabled={submitting || trimmed === "" || overCap}
              startIcon={
                submitting ? <CircularProgress size={16} /> : undefined
              }
            >
              {submitting ? "Filing…" : "File issue"}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  );
}
