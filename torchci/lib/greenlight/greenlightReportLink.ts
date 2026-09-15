// The one spelling of the "report a wrong verdict" deep link.
//
// It sits below both greenlightRender.ts (which puts the link in a comment) and
// greenlightReport.ts (which builds the issue the link leads to) because those
// two already point the other way -- greenlightReport imports the renderer's
// defanging and status vocabulary -- and a builder in either would close a cycle.
// greenlight/src/greenlight/comment_format.py renders the same link into
// greenlight's own comment, and test_render_sync.py pins the two together.
//
// The URL is assembled from a ClickHouse column (`head_sha`) and rendered into a
// comment authored by a bot, so every part of it is checked before anything is
// emitted: an unchecked value inside `[text](url)` is a link target an author
// could choose. The guards are whole-string and the builder returns "" rather
// than a half-valid URL, which is what lets the callers treat "no link" as the
// only failure mode.

const HUD_BASE_URL = "https://hud.pytorch.org";

/**
 * Tells the HUD's verdict panel to open its report dialog on arrival. `sha` is
 * carried separately because it is the PR page's own commit picker parameter --
 * the panel has to be showing the verdict being disputed before there is
 * anything to report, and that is the parameter that selects it.
 */
export const GREENLIGHT_REPORT_PARAM = "greenlightReport";

const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const FULL_SHA_RE = /^[0-9a-fA-F]{40}$/;

/**
 * The HUD deep link for disputing the verdict on `headSha`, or "" when any part
 * of it fails its guard. Callers render nothing for "".
 */
export function greenlightReportUrl(
  repo: string,
  prNumber: number,
  headSha: string
): string {
  const sha = (headSha || "").trim();
  if (
    !REPO_RE.test(repo || "") ||
    !Number.isSafeInteger(prNumber) ||
    prNumber <= 0 ||
    !FULL_SHA_RE.test(sha)
  ) {
    return "";
  }
  return `${HUD_BASE_URL}/${repo}/pull/${prNumber}?sha=${sha.toLowerCase()}&${GREENLIGHT_REPORT_PARAM}=1`;
}

/** The HUD origin, for the plain links that are not this deep link. */
export { HUD_BASE_URL as GREENLIGHT_HUD_BASE_URL };
