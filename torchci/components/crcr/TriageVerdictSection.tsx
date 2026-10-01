import { Chip, ChipProps, useTheme } from "@mui/material";
import { LocalTimeHuman } from "components/common/TimeUtils";
import {
  isSuspectedPrUnderTest,
  TriageCategory,
  TriageVerdict,
} from "lib/crcr/triageVerdict";

const linkStyle = { color: "var(--link-color, #58a6ff)" };

// Only the upstream-vs-backend split matters for triage (and, later, for the
// adjusted pass rate); infra, flake and unknown are all "not the code".
const CATEGORY_COLOR: Record<TriageCategory, ChipProps["color"]> = {
  upstream: "warning",
  backend: "error",
  infra: "default",
  flake: "default",
  unknown: "default",
};

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={linkStyle}>
      {children}
    </a>
  );
}

// The downstream repo's own analysis of why this job failed, shown in the
// per-repo job tooltip. Advisory: it never changes the job's conclusion.
export default function TriageVerdictSection({
  verdict,
  prNumber,
  upstreamRepo,
}: {
  verdict: TriageVerdict;
  prNumber?: number;
  upstreamRepo: string;
}) {
  const theme = useTheme();

  const repoUrl = `https://github.com/${upstreamRepo || "pytorch/pytorch"}`;
  const suspected = verdict.suspected_upstream;
  const underTest = isSuspectedPrUnderTest(verdict, prNumber);
  const evidence = verdict.evidence ?? [];
  const analyzer = verdict.analyzer;
  const provenance = [
    [analyzer?.name, analyzer?.version].filter(Boolean).join(" "),
    analyzer?.model,
    analyzer?.prompt_version && `prompt ${analyzer.prompt_version}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const analyzedAt =
    verdict.analyzed_at && !Number.isNaN(Date.parse(verdict.analyzed_at))
      ? verdict.analyzed_at
      : null;

  return (
    <div
      style={{
        marginTop: 8,
        borderTop: "1px solid",
        paddingTop: 6,
        // The tooltip sizes to its content; without a cap, a long summary
        // would stretch it across the whole screen.
        maxWidth: 480,
        whiteSpace: "normal",
        overflowWrap: "anywhere",
      }}
    >
      <div>
        <span style={{ fontWeight: 600 }}>AI triage</span>{" "}
        <Chip
          label={verdict.category}
          color={CATEGORY_COLOR[verdict.category]}
          size="small"
          sx={{ height: 18, fontSize: "0.7rem", verticalAlign: "text-bottom" }}
        />{" "}
        <span style={{ opacity: 0.75 }}>
          {verdict.confidence} confidence · advisory
        </span>
      </div>
      <div style={{ whiteSpace: "pre-wrap", marginTop: 2 }}>
        {verdict.summary}
      </div>

      {suspected && (
        <div style={{ marginTop: 4 }}>
          Suspected cause:{" "}
          {suspected.pr !== undefined && (
            <ExternalLink href={`${repoUrl}/pull/${suspected.pr}`}>
              #{suspected.pr}
            </ExternalLink>
          )}
          {underTest !== null && (underTest ? " (this PR)" : " (not this PR)")}
          {suspected.pr !== undefined && suspected.commit && " · "}
          {suspected.commit && (
            <ExternalLink href={`${repoUrl}/commit/${suspected.commit}`}>
              <span style={{ fontFamily: "monospace" }}>
                {suspected.commit.slice(0, 10)}
              </span>
            </ExternalLink>
          )}
          {suspected.reason && (
            <div style={{ opacity: 0.75 }}>{suspected.reason}</div>
          )}
        </div>
      )}

      {verdict.reproduced_on_retry !== undefined && (
        <div style={{ marginTop: 2 }}>
          Reproduced on retry: {verdict.reproduced_on_retry ? "yes" : "no"}
        </div>
      )}

      {evidence.length > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: "pointer" }}>
            Evidence ({evidence.length})
          </summary>
          {evidence.map((e, i) => (
            <div key={i} style={{ marginTop: 4, fontSize: "0.7rem" }}>
              {[e.job, e.test].filter(Boolean).join(" › ")}
              {e.log_url && (
                <>
                  {" "}
                  <ExternalLink href={e.log_url}>log ›</ExternalLink>
                </>
              )}
              {e.excerpt && (
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    maxHeight: 120,
                    overflow: "auto",
                    margin: "2px 0",
                    padding: 4,
                    borderRadius: 4,
                    background: theme.palette.action.hover,
                  }}
                >
                  {e.excerpt}
                </pre>
              )}
            </div>
          ))}
        </details>
      )}

      {(provenance || analyzedAt) && (
        <div style={{ marginTop: 4, fontSize: "0.7rem", opacity: 0.6 }}>
          {provenance}
          {provenance && analyzedAt && " · "}
          {analyzedAt && <LocalTimeHuman timestamp={analyzedAt} />}
        </div>
      )}
    </div>
  );
}
