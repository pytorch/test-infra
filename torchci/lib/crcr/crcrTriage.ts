// Dr.CI side of the CRCR downstream triage verdict: the "AI verdict:" line under
// a CRCR job in the comment.
//
// The verdict comes with the callback (see the triage-verdict input of
// .github/actions/cross-repo-ci-relay-callback), so unlike the in-tree AI CI
// Advisor there is nothing to dispatch and no run to match: each
// crcr_workflow_job row carries the verdict for exactly that run.
//
// Advisory only: the line is shown and nothing else changes.
// An L4 failure blocks and an L3 failure does not, whatever the verdict says.
//
// The downstream's categories are translated into the in-tree advisor's verdict
// vocabulary (not related / infra issue / garbage / related / inconclusive) so
// the line reads like the one under an in-tree failure.

import {
  ADVISOR_ALT_PREFIX,
  ConfidenceBucket,
  verdictBadgeForBucket,
} from "lib/advisor/advisorBadge";
import { AdvisorVerdictType } from "lib/advisorVerdictUtils";
import {
  isHttpUrl,
  isSuspectedPrUnderTest,
  parseTriageVerdict,
  TriageConfidence,
  TriageVerdict,
} from "lib/crcr/triageVerdict";
import { RecentWorkflowsData } from "lib/types";
import _ from "lodash";

// The advisor's badge wants a confidence bucket; a downstream states one of three
// words, which the relay and parseTriageVerdict both enforce. Typed as a
// Record so a fourth level fails to compile until it is given a bucket.
const CONFIDENCE_BUCKET: Record<TriageConfidence, ConfidenceBucket> = {
  high: "high",
  medium: "med",
  low: "low",
};

export interface AdvisorStyleVerdict {
  verdict: AdvisorVerdictType;
  confidence: ConfidenceBucket;
}

/**
 * The downstream verdict in the in-tree advisor's terms.
 *
 *   backend                  not_related   the backend's own bug
 *   infra                    infra_issue
 *   flake                    garbage       the signal is noise
 *   upstream, another PR     not_related   a regression already on main
 *   upstream, this PR        related
 *   upstream, no PR named    related
 *   unknown                  unsure
 *
 * The confidence is the one the downstream reported, passed through as is.
 */
export function toAdvisorVerdict(
  verdict: TriageVerdict,
  prNumber: number
): AdvisorStyleVerdict {
  const confidence = CONFIDENCE_BUCKET[verdict.confidence];
  switch (verdict.category) {
    case "backend":
      return { verdict: "not_related", confidence };
    case "infra":
      return { verdict: "infra_issue", confidence };
    case "flake":
      return { verdict: "garbage", confidence };
    case "upstream":
      // Another PR is a regression already on main; this PR, or none named, is
      // not shown to be anyone else's.
      return {
        verdict:
          isSuspectedPrUnderTest(verdict, prNumber) === false
            ? "not_related"
            : "related",
        confidence,
      };
    case "unknown":
      return { verdict: "unsure", confidence };
  }
}

// The verdict is self-reported by the downstream repo and only shape-checked
// by the relay, so every string is escaped and newlines collapsed before it
// goes into the comment, as renderVerdictLine does for the advisor summary.
function oneLine(text: string): string {
  return _.escape(text.replace(/\s*\n\s*/g, " ").trim());
}

// The pill. Unlike the advisor's, it is a pure function of the verdict, so the
// URL carries it instead of naming a job to look up (see api/drci/crcrBadge).
export function crcrBadgeUrl(
  hudBaseUrl: string,
  mapped: AdvisorStyleVerdict
): string {
  const qs = new URLSearchParams({
    verdict: mapped.verdict,
    confidence: mapped.confidence,
  });
  return `${hudBaseUrl}/api/drci/crcrBadge?${qs.toString()}`;
}

/**
 * The "AI verdict:" line for one CRCR job, in the shape renderVerdictLine gives
 * an in-tree failure: the label's text is the badge's alt, the summary sits in
 * the expand. The expand also says whose verdict it is -- here the downstream
 * repo's, not the in-tree advisor's -- and what it suspects.
 *
 * The HUD keeps nothing about the verdict, so both links go to the downstream
 * workflow run (`runUrl`, its workflow_run_url) where the logs are. That URL is
 * self-reported, so anything but a plain http(s) URL drops the links rather
 * than reaching an href.
 */
export function renderCrcrTriageLine(
  verdict: TriageVerdict,
  hudBaseUrl: string,
  owner: string,
  repo: string,
  prNumber: number,
  runUrl: string
): string {
  const mapped = toAdvisorVerdict(verdict, prNumber);
  const link = isHttpUrl(runUrl) ? _.escape(runUrl) : "";
  const alt = _.escape(
    `${ADVISOR_ALT_PREFIX}${
      verdictBadgeForBucket(mapped.verdict, mapped.confidence).label
    }`
  );
  const badge = _.escape(crcrBadgeUrl(hudBaseUrl, mapped));
  const suspected = verdict.suspected_upstream;
  const analyzer = verdict.analyzer?.name;
  const source = analyzer
    ? `the downstream repo's triage (${oneLine(analyzer)})`
    : "the downstream repo's triage";
  return (
    `  <details><summary>AI verdict: ${
      link
        ? `<a href="${link}"><img alt="${alt}" src="${badge}"></a>`
        : `<img alt="${alt}" src="${badge}">`
    }</summary><blockquote>\n\n` +
    `  ${oneLine(verdict.summary)}\n\n` +
    (suspected?.pr !== undefined
      ? // An integer by validation (parseTriageVerdict), so safe to interpolate.
        `  Suspected upstream change: <a href="https://github.com/${owner}/${repo}/pull/${
          suspected.pr
        }">#${suspected.pr}</a>${
          suspected.reason ? ` (${oneLine(suspected.reason)})` : ""
        }\n\n`
      : suspected?.reason
      ? `  Suspected cause: ${oneLine(suspected.reason)}\n\n`
      : "") +
    `  <sub>Verdict from ${source}.</sub>\n\n` +
    (link ? `  <a href="${link}">Full log details &rarr;</a>\n` : "") +
    `  </blockquote></details>\n`
  );
}

/**
 * job.id -> rendered verdict line, for every CRCR job that carries a valid
 * verdict. Keyed like the advisor lines so the comment renderer can show both
 * through the same map; CRCR ids are downstream check-run ids and never collide
 * with this repo's job ids.
 */
export function buildCrcrTriageLines(
  jobs: RecentWorkflowsData[],
  hudBaseUrl: string,
  owner: string,
  repo: string,
  prNumber: number
): Map<number, string> {
  const lines = new Map<number, string>();
  for (const job of jobs) {
    const verdict = parseTriageVerdict(job.triageVerdictJson);
    if (verdict !== null) {
      lines.set(
        job.id,
        renderCrcrTriageLine(
          verdict,
          hudBaseUrl,
          owner,
          repo,
          prNumber,
          job.html_url
        )
      );
    }
  }
  return lines;
}
