import { Alert, Box, Chip, Typography } from "@mui/material";
import AdvisorSection from "components/job/AdvisorSection";
import { AdvisorVerdict } from "lib/advisorVerdictUtils";
import { AutorevertStateResponse, ensureUtc, Outcome } from "./types";

interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  time: string;
}

interface CommitSummaryProps {
  sha: string;
  state: AutorevertStateResponse;
  commitInfo?: CommitInfo;
  advisorVerdicts?: AdvisorVerdict[];
  repo: string;
}

function formatLocalTime(isoTime: string): string {
  return new Date(ensureUtc(isoTime)).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Summary section shown at the top when ar_sha is in the URL.
 * Explains in plain text what happened to this commit.
 */
export default function CommitSummary({
  sha,
  state,
  commitInfo,
  advisorVerdicts,
  repo,
}: CommitSummaryProps) {
  const shortSha = sha.slice(0, 7);
  const prMatch = commitInfo?.message?.match(/\(#(\d+)\)/);
  const prNum = prMatch ? prMatch[1] : null;
  const title = commitInfo?.message?.split("\n")[0] || "";

  // Find outcomes where this commit is the suspect
  const revertOutcomes: Array<{ key: string; outcome: Outcome }> = [];
  const restartOutcomes: Array<{ key: string; outcome: Outcome }> = [];

  for (const [key, outcome] of Object.entries(state.outcomes || {})) {
    if (
      outcome.type === "AutorevertPattern" &&
      outcome.data.suspected_commit === sha
    ) {
      revertOutcomes.push({ key, outcome });
    }
    if (
      outcome.type === "RestartCommits" &&
      outcome.data.commit_shas?.includes(sha)
    ) {
      restartOutcomes.push({ key, outcome });
    }
  }

  // Find advisor verdicts for this commit
  const shaVerdicts = (advisorVerdicts || []).filter(
    (v) => v.sha.trim() === sha.trim()
  );

  const hasAction = revertOutcomes.length > 0 || restartOutcomes.length > 0;
  const severity = revertOutcomes.length > 0 ? "error" : "warning";

  return (
    <Alert
      severity={hasAction ? severity : "info"}
      variant="outlined"
      sx={{ mb: 2 }}
    >
      {/* Commit identity */}
      <Typography variant="subtitle1" fontWeight="bold" sx={{ mb: 0.5 }}>
        Commit{" "}
        <a
          href={`https://github.com/${repo}/commit/${sha}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "inherit" }}
        >
          {shortSha}
        </a>
        {prNum && (
          <>
            {" — PR "}
            <a
              href={`https://github.com/${repo}/pull/${prNum}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "inherit" }}
            >
              #{prNum}
            </a>
          </>
        )}
        {title && (
          <span style={{ fontWeight: 400, marginLeft: 6 }}>
            {title
              .replace(/\s*\(#\d+\)\s*$/, "")
              .slice(0, 100)}
          </span>
        )}
      </Typography>

      {commitInfo && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {commitInfo.author} ·{" "}
          {formatLocalTime(commitInfo.time)}
        </Typography>
      )}

      {/* Revert decisions */}
      {revertOutcomes.map(({ key, outcome }) => {
        const d = outcome.data as any;
        const newerCount = d.newer_failing_commits?.length || 0;
        return (
          <Box key={key} sx={{ mb: 1 }}>
            <Chip
              label="REVERT"
              size="small"
              sx={{ backgroundColor: "#d32f2f", color: "#fff", mr: 1 }}
            />
            <Typography variant="body2" component="span">
              Signal <strong>{key.split(":").slice(1).join(":")}</strong>{" "}
              failed on this commit
              {newerCount > 0 &&
                ` and ${newerCount} newer commit${newerCount > 1 ? "s" : ""}`}
              . It was passing on baseline{" "}
              <code>{d.older_successful_commit?.slice(0, 7)}</code>.
            </Typography>
          </Box>
        );
      })}

      {/* Restart decisions */}
      {restartOutcomes.map(({ key }) => (
        <Box key={key} sx={{ mb: 1 }}>
          <Chip
            label="RESTART"
            size="small"
            sx={{ backgroundColor: "#1976d2", color: "#fff", mr: 1 }}
          />
          <Typography variant="body2" component="span">
            Signal <strong>{key.split(":").slice(1).join(":")}</strong>{" "}
            — CI being restarted to confirm failure pattern.
          </Typography>
        </Box>
      ))}

      {!hasAction && (
        <Typography variant="body2">
          No active autorevert action on this commit at this snapshot time.
        </Typography>
      )}

      {/* AI advisor verdicts with signal context */}
      {shaVerdicts.map((v, i) => (
        <Box key={i} sx={{ mt: 1 }}>
          <Typography
            variant="body2"
            sx={{ mb: 0.5, fontWeight: 600, fontSize: "0.85rem", color: "#d32f2f" }}
          >
            Failure: {v.workflowName}: {v.signalKey}
          </Typography>
          <AdvisorSection
            verdict={v}
            repoOwner={repo.split("/")[0]}
            repoName={repo.split("/")[1]}
          />
        </Box>
      ))}

      {/* Links */}
      <Box sx={{ mt: 1, display: "flex", gap: 2, fontSize: "0.85rem" }}>
        {prNum && (
          <a
            href={`https://github.com/${repo}/pull/${prNum}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            View PR →
          </a>
        )}
        <a
          href={`https://hud.pytorch.org/${repo}/commit/${sha}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View in HUD →
        </a>
      </Box>
    </Alert>
  );
}
