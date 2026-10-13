// Mirrors greenlight/src/greenlight/review_gate.py on the scheduled scan, which
// skips a PR a human has already decided and records nothing for it.
// BOT_LOGINS must match the one in greenlight/src/greenlight/pr_hash.py.

// The fields read from a pulls.listReviews item.
export interface GateReview {
  state: string;
  user: { login: string; type?: string } | null;
}

const BOT_LOGINS = new Set([
  "pytorchbot",
  "pytorch-bot",
  "pytorchmergebot",
  "pytorchupdatebot",
  "github-actions",
  "dependabot",
  "facebook-github-bot",
  "facebook-github-tools",
  "meta-codesync",
  "codecov",
  "codecov-commenter",
  "linux-foundation-easycla",
]);

export function isBot(login: string, type: string | undefined): boolean {
  const normalized = login.toLowerCase();
  return (
    type?.toLowerCase() === "bot" ||
    normalized.endsWith("[bot]") ||
    BOT_LOGINS.has(normalized)
  );
}

export async function isHumanDecided(
  reviews: GateReview[],
  isAuthorized: (_login: string) => Promise<boolean>
): Promise<boolean> {
  const latest = new Map<string, GateReview>();
  for (const review of reviews) {
    const login = review.user?.login;
    if (login && review.state !== "COMMENTED") {
      latest.set(login, review);
    }
  }
  const humans = Array.from(latest).filter(
    ([login, review]) => !isBot(login, review.user?.type)
  );
  if (humans.some(([, review]) => review.state === "CHANGES_REQUESTED")) {
    return true;
  }
  for (const [login, review] of humans) {
    if (review.state === "APPROVED" && (await isAuthorized(login))) {
      return true;
    }
  }
  return false;
}
