// SVG pill for a CRCR downstream triage verdict, embedded in the Dr.CI comment.
//
// Unlike advisorBadge, which looks a job's verdict up, the verdict is in the
// URL (lib/crcr/crcrTriage.crcrBadgeUrl): the pill is a pure function of it, so
// there is nothing to read and nothing to flip later. The verdict must be one
// of the advisor's own and the confidence one of its buckets, so the public
// endpoint can only draw the labels verdictBadge already has -- never
// caller-chosen text.

import {
  ConfidenceBucket,
  PENDING_BADGE,
  renderBadgeSvg,
  verdictBadgeForBucket,
} from "lib/advisor/advisorBadge";
import type { NextApiRequest, NextApiResponse } from "next";

const VERDICTS = new Set([
  "not_related",
  "infra_issue",
  "garbage",
  "related",
  "unsure",
]);

const BUCKETS = new Set<string>(["high", "med", "low"]);

const LONG_CACHE =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : value ?? "";
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const verdict = one(req.query.verdict);
  const confidence = one(req.query.confidence);

  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  // Bad input -> a neutral pill, never a 4xx (a broken image in the comment).
  if (!VERDICTS.has(verdict) || !BUCKETS.has(confidence)) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(renderBadgeSvg(PENDING_BADGE));
    return;
  }
  res.setHeader("Cache-Control", LONG_CACHE);
  res
    .status(200)
    .send(
      renderBadgeSvg(
        verdictBadgeForBucket(verdict, confidence as ConfidenceBucket)
      )
    );
}
