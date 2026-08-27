// The logins Green Light's backend will act on. Mirrors TRUSTED_AUTHORS in
// greenlight/src/greenlight/review.py, which is the source of truth: the
// backend refuses a recheck from anyone else and returns cleanly, with no
// comment, no state row and a green workflow run, so a requester off this list
// gets no feedback from anywhere unless the bot itself refuses first.
//
// Kept as a plain array literal because greenlight/tests/test_render_sync.py
// pins it against the Python set by regex-parsing this source, the same way it
// pins GREENLIGHT_REPOS in torchci/lib/greenlight/greenlightConfig.ts.
export const GREENLIGHT_TRUSTED_AUTHORS: string[] = [
  "albanD",
  "jathu",
  "atalman",
  "huydhn",
  "izaitsevfb",
  "georgehong",
  "jeanschmidt",
  "ezyang",
  "drisspg",
  "janeyx99",
];

// GitHub logins are case-insensitive, and review.py folds the same way before
// comparing, so a differently-cased login must not fall out of the gate here
// and then be accepted there.
const trustedLower = new Set(
  GREENLIGHT_TRUSTED_AUTHORS.map((login) => login.toLowerCase())
);

export function isTrustedAuthor(login: string): boolean {
  return trustedLower.has(login.toLowerCase());
}
