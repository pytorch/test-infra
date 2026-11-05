import { z } from "zod/v4";

// A pull request as the pull request endpoint and the pull request page
// address it: its number in the repository, as GitHub's URL spells it. Zod
// only, so the pages can import it into the browser.
const NUMBER_ERROR = "number must be a pull request number, a positive integer";

export const PullRequestNumberSchema = z
  .string({ error: NUMBER_ERROR })
  .regex(/^[1-9][0-9]{0,9}$/, { error: NUMBER_ERROR })
  .transform((value) => Number(value))
  .describe(
    "The pull request's number in the repository, as its GitHub URL spells it: 203277 for https://github.com/pytorch/pytorch/pull/203277. Decimal digits, no leading zero."
  );
