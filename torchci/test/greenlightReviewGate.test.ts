import {
  GateReview,
  isHumanDecided,
} from "lib/greenlight/greenlightReviewGate";

function review(
  state: string,
  login: string | null,
  type = "User"
): GateReview {
  return { state, user: login === null ? null : { login, type } };
}

// Only "approver" may merge, matched case-insensitively.
async function isAuthorized(login: string): Promise<boolean> {
  return login.toLowerCase() === "approver";
}

describe("isHumanDecided", () => {
  const CASES: [string, GateReview[], boolean][] = [
    ["no reviews", [], false],
    ["a human's change request", [review("CHANGES_REQUESTED", "bob")], true],
    [
      "a change request a later comment leaves standing",
      [review("CHANGES_REQUESTED", "bob"), review("COMMENTED", "bob")],
      true,
    ],
    [
      "an approval a later comment leaves standing",
      [review("APPROVED", "approver"), review("COMMENTED", "approver")],
      true,
    ],
    [
      "an approval a later dismissal replaces",
      [review("APPROVED", "approver"), review("DISMISSED", "approver")],
      false,
    ],
    [
      "a change request a later unauthorized approval replaces",
      [review("CHANGES_REQUESTED", "bob"), review("APPROVED", "bob")],
      false,
    ],
    [
      "a change request a later pending review replaces",
      [review("CHANGES_REQUESTED", "bob"), review("PENDING", "bob")],
      false,
    ],
    [
      "a Bot-typed account's change request",
      [review("CHANGES_REQUESTED", "some-app", "Bot")],
      false,
    ],
    [
      "a [bot] login's change request",
      [review("CHANGES_REQUESTED", "renovate[BOT]")],
      false,
    ],
    [
      "a bot-list login's change request, in another case",
      [review("CHANGES_REQUESTED", "PyTorchMergeBot")],
      false,
    ],
    [
      "an authorized approval, in another case",
      [review("APPROVED", "Approver")],
      true,
    ],
    ["an unauthorized approval", [review("APPROVED", "bob")], false],
    [
      "an authorized bot's approval",
      [review("APPROVED", "approver", "Bot")],
      false,
    ],
    ["a review with no user", [review("CHANGES_REQUESTED", null)], false],
    ["a review with an empty login", [review("CHANGES_REQUESTED", "")], false],
  ];

  it.each(CASES)("decides %s", async (_, reviews, decided) => {
    expect(await isHumanDecided(reviews, isAuthorized)).toBe(decided);
  });
});
